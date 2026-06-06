/**
 * Cron job registry.
 * All scheduled tasks for the salones-wa system.
 */

import cron from "node-cron";
import type Database from "better-sqlite3";
import {
  getUpcomingAppointmentsFor24h,
  getUpcomingAppointmentsFor2h,
  markReminded24h,
  markReminded2h,
  completePassedAppointments,
  updateDormantFlags,
  getDormantContacts,
  createCampaign,
  hasRecentCampaign,
  getServices,
  getAllActiveSalons,
} from "../db/models.js";
import { conversationState } from "../bot/conversation-state.js";
import {
  disconnectAlertHours,
  evaluateSalonHealth,
  findStaleSalons,
  getAllSalonConnStates,
  getBootTime,
} from "../bot/baileys-state.js";

export type SendMessageFn = (
  salonPhone: string,
  toPhone: string,
  text: string,
) => Promise<void>;

export interface RegisteredJob {
  name: string;
  schedule: string;
}

/**
 * Register all cron jobs.
 * @param db SQLite database instance
 * @param sendMessage Async function that sends a WA message
 * @returns List of registered job descriptors
 */
export function registerCrons(
  db: Database.Database,
  sendMessage: SendMessageFn,
): RegisteredJob[] {
  const jobs: RegisteredJob[] = [];

  // ─── remind-24h: every hour at :05 ───────────────────────────────────
  cron.schedule("5 * * * *", async () => {
    const appointments = getUpcomingAppointmentsFor24h(db);
    for (const appt of appointments) {
      try {
        const contact = db
          .prepare("SELECT * FROM contacts WHERE id = ?")
          .get(appt.contact_id) as {
          id: string;
          phone: string;
          name: string | null;
          opt_out: number;
          salon_id: string;
          visit_count: number;
          dormant: number;
          last_visit: number | null;
          created_at: number;
        };
        if (!contact || contact.opt_out) continue;

        const salon = db
          .prepare("SELECT * FROM salons WHERE id = ?")
          .get(appt.salon_id) as { phone: string } | undefined;
        if (!salon) continue;

        const services = getServices(db, appt.salon_id);
        const service = appt.service_id
          ? services.find((s) => s.id === appt.service_id)
          : undefined;

        const { Messages } = await import("../bot/messages.js");
        const text = Messages.reminder24h(contact, appt, service);

        await sendMessage(salon.phone, contact.phone, text);
        markReminded24h(db, appt.id);
      } catch (err) {
        console.error("[remind-24h] error for appt", appt.id, err);
      }
    }
  });
  jobs.push({ name: "remind-24h", schedule: "5 * * * *" });

  // ─── remind-2h: every 30 min ──────────────────────────────────────────
  cron.schedule("*/30 * * * *", async () => {
    const appointments = getUpcomingAppointmentsFor2h(db);
    for (const appt of appointments) {
      try {
        const contact = db
          .prepare("SELECT * FROM contacts WHERE id = ?")
          .get(appt.contact_id) as {
          id: string;
          phone: string;
          name: string | null;
          opt_out: number;
          salon_id: string;
          visit_count: number;
          dormant: number;
          last_visit: number | null;
          created_at: number;
        };
        if (!contact || contact.opt_out) continue;

        const salon = db
          .prepare("SELECT * FROM salons WHERE id = ?")
          .get(appt.salon_id) as { phone: string } | undefined;
        if (!salon) continue;

        const services = getServices(db, appt.salon_id);
        const service = appt.service_id
          ? services.find((s) => s.id === appt.service_id)
          : undefined;

        const { Messages } = await import("../bot/messages.js");
        const text = Messages.reminder2h(contact, appt, service);

        await sendMessage(salon.phone, contact.phone, text);
        markReminded2h(db, appt.id);
      } catch (err) {
        console.error("[remind-2h] error for appt", appt.id, err);
      }
    }
  });
  jobs.push({ name: "remind-2h", schedule: "*/30 * * * *" });

  // ─── mark-completed: every hour at :10 ───────────────────────────────
  cron.schedule("10 * * * *", () => {
    try {
      const count = completePassedAppointments(db);
      if (count > 0)
        console.log(`[mark-completed] ${count} appointments completed`);
    } catch (err) {
      console.error("[mark-completed] error", err);
    }
  });
  jobs.push({ name: "mark-completed", schedule: "10 * * * *" });

  // ─── update-dormant: daily at 00:15 ──────────────────────────────────
  cron.schedule("15 0 * * *", () => {
    try {
      const count = updateDormantFlags(db);
      console.log(`[update-dormant] ${count} contacts updated`);
    } catch (err) {
      console.error("[update-dormant] error", err);
    }
  });
  jobs.push({ name: "update-dormant", schedule: "15 0 * * *" });

  // ─── reactivation-campaign: Mondays at 10:00 ─────────────────────────
  cron.schedule("0 10 * * 1", async () => {
    try {
      const salons = db
        .prepare("SELECT * FROM salons WHERE active = 1")
        .all() as Array<{ id: string; phone: string }>;
      // W5: Rate limit is per-salon (not global) to ensure fair multi-tenant distribution
      const RATE_LIMIT_PER_SALON = 20;
      let totalSent = 0;

      for (const salon of salons) {
        const dormants = getDormantContacts(db, salon.id);
        let salonSent = 0;

        for (const contact of dormants) {
          if (salonSent >= RATE_LIMIT_PER_SALON) {
            console.log(
              `[reactivation] salon ${salon.id} rate limit reached (${RATE_LIMIT_PER_SALON}), moving to next salon`,
            );
            break;
          }

          if (hasRecentCampaign(db, contact.id, 30)) continue;

          const { Messages } = await import("../bot/messages.js");
          const text = Messages.reactivationOutbound(contact);

          // W6: Send BEFORE recording — only record if send succeeded
          await sendMessage(salon.phone, contact.phone, text);

          // Send succeeded — now record campaign + arm state
          const campaign = createCampaign(db, {
            salon_id: salon.id,
            contact_id: contact.id,
            type: "reactivation",
          });

          conversationState.set(
            {
              step: "reactivation_sent",
              salon_id: salon.id,
              contact_id: contact.id,
              campaign_id: campaign.id,
              updated_at: Date.now(),
            },
            contact.phone,
          );

          salonSent++;
          totalSent++;
          // Small delay between messages (anti-ban)
          await new Promise((r) => setTimeout(r, 2000 + Math.random() * 3000));
        }
      }
      console.log(
        `[reactivation-campaign] sent ${totalSent} messages across ${salons.length} salons`,
      );
    } catch (err) {
      console.error("[reactivation-campaign] error", err);
    }
  });
  jobs.push({ name: "reactivation-campaign", schedule: "0 10 * * 1" });

  // ─── state-eviction: every 30 min ────────────────────────────────────
  cron.schedule("*/30 * * * *", () => {
    const evicted = conversationState.evictExpired();
    if (evicted > 0)
      console.log(
        `[state-eviction] evicted ${evicted} stale conversation states`,
      );
  });
  jobs.push({ name: "state-eviction", schedule: "*/30 * * * *" });

  // ─── disconnect-watch: daily 09:00 (MX) ───────────────────────────────
  // Logs a WARN for any active salon whose Baileys link has been down past
  // the alert threshold (SALON_DISCONNECT_ALERT_HOURS, default 24h). It does
  // NOT message anyone — the durable ">24h" alert is owned by mc-prometheus,
  // which scrapes /metrics and applies a `for:` clause that survives this
  // process restarting. This cron is the local, human-readable journalctl
  // breadcrumb (the "log" half of the chosen "log + flag" design; the "flag"
  // is the `stale` boolean surfaced on /health/salons and /metrics).
  cron.schedule("0 9 * * *", () => {
    try {
      const salons = getAllActiveSalons(db);
      const records = new Map(
        getAllSalonConnStates().map((r) => [r.salonId, r]),
      );
      const nowMs = Date.now();
      const thresholdHours = disconnectAlertHours();
      const thresholdMs = thresholdHours * 3_600_000;
      const bootMs = getBootTime();
      const healths = salons.map((s) =>
        evaluateSalonHealth(s, records.get(s.id), {
          nowMs,
          thresholdMs,
          bootMs,
        }),
      );
      const stale = findStaleSalons(healths);
      if (stale.length === 0) {
        console.log(
          `[disconnect-watch] all ${salons.length} active salon(s) healthy`,
        );
        return;
      }
      for (const h of stale) {
        // NOTE: measured from lastConnectedAt-or-boot, so right after a
        // process restart this UNDER-reports true downtime (counts from boot).
        // It's a human breadcrumb only — mc-prometheus's `for:` clause over
        // the scraped gauge is the source of truth for the actual alert.
        const hrs =
          h.downForSeconds != null ? (h.downForSeconds / 3600).toFixed(1) : "?";
        console.warn(
          `[disconnect-watch] WARN salon "${h.name}" (${h.phone}) state=${h.state} down ~${hrs}h (>${thresholdHours}h threshold) — mc-prometheus will alert`,
        );
      }
    } catch (err) {
      console.error("[disconnect-watch] error", err);
    }
  });
  jobs.push({ name: "disconnect-watch", schedule: "0 9 * * *" });

  return jobs;
}
