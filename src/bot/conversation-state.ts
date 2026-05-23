/**
 * In-memory conversation state machine.
 * Tracks pending flows per phone number within a salon.
 * State is NOT persisted — resets on restart (acceptable for MVP).
 */

export type ConversationStep =
  | 'idle'
  | 'awaiting_service'
  | 'awaiting_date'
  | 'awaiting_slot_selection'
  | 'awaiting_cancel_confirm'
  | 'reactivation_sent'  // waiting for yes/no after reactivation outbound

export interface ConversationState {
  step: ConversationStep
  salon_id: string
  contact_id: string
  /** Pending service selection */
  pending_service_id?: string
  /** Pending slot options offered to user */
  pending_slots?: Array<{ starts_at: number; ends_at: number; label: string }>
  /** Pending appointment to cancel */
  pending_cancel_id?: string
  /** Campaign ID linked to reactivation */
  campaign_id?: string
  updated_at: number
}

const STATE_TTL_MS = 30 * 60 * 1000 // 30 min idle timeout

class ConversationStateManager {
  private store = new Map<string, ConversationState>()

  private key(salon_id: string, phone: string): string {
    return `${salon_id}:${phone}`
  }

  get(salon_id: string, phone: string): ConversationState | null {
    const key = this.key(salon_id, phone)
    const state = this.store.get(key)
    if (!state) return null
    if (Date.now() - state.updated_at > STATE_TTL_MS) {
      this.store.delete(key)
      return null
    }
    return state
  }

  set(state: ConversationState, phone: string): void {
    const key = this.key(state.salon_id, phone)
    // Preserve the provided updated_at (useful for tests); only default to now if absent
    this.store.set(key, { ...state, updated_at: state.updated_at ?? Date.now() })
  }

  clear(salon_id: string, phone: string): void {
    this.store.delete(this.key(salon_id, phone))
  }

  /** Periodic cleanup — call from a cron or timer */
  evictExpired(): number {
    const now = Date.now()
    let count = 0
    for (const [key, state] of this.store.entries()) {
      if (now - state.updated_at > STATE_TTL_MS) {
        this.store.delete(key)
        count++
      }
    }
    return count
  }
}

export const conversationState = new ConversationStateManager()
