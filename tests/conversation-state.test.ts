import { describe, it, expect, vi, afterEach } from 'vitest'
import { conversationState } from '../src/bot/conversation-state.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ConversationStateManager', () => {
  const SALON = 'salon-1'
  const PHONE = '+5255100001'

  it('returns null for non-existent state', () => {
    expect(conversationState.get(SALON, PHONE)).toBeNull()
  })

  it('stores and retrieves state', () => {
    const state = {
      step: 'awaiting_slot_selection' as const,
      salon_id: SALON,
      contact_id: 'contact-1',
      updated_at: Date.now(),
    }
    conversationState.set(state, PHONE)
    const retrieved = conversationState.get(SALON, PHONE)
    expect(retrieved?.step).toBe('awaiting_slot_selection')
  })

  it('clears state', () => {
    conversationState.set({
      step: 'idle',
      salon_id: SALON,
      contact_id: 'c1',
      updated_at: Date.now(),
    }, PHONE)
    conversationState.clear(SALON, PHONE)
    expect(conversationState.get(SALON, PHONE)).toBeNull()
  })

  it('returns null for expired state (>30 min)', () => {
    const oldTime = Date.now() - 31 * 60 * 1000
    conversationState.set({
      step: 'awaiting_slot_selection',
      salon_id: SALON,
      contact_id: 'c1',
      updated_at: oldTime,
    }, PHONE)
    expect(conversationState.get(SALON, PHONE)).toBeNull()
  })

  it('evicts expired states', () => {
    const oldTime = Date.now() - 31 * 60 * 1000
    conversationState.set({
      step: 'awaiting_slot_selection',
      salon_id: SALON,
      contact_id: 'c1',
      updated_at: oldTime,
    }, '+5255100099')
    const evicted = conversationState.evictExpired()
    expect(evicted).toBeGreaterThan(0)
  })

  it('different salons have separate state', () => {
    conversationState.set({
      step: 'awaiting_slot_selection',
      salon_id: 'salon-A',
      contact_id: 'c1',
      updated_at: Date.now(),
    }, PHONE)
    // salon-B with same phone should be null
    expect(conversationState.get('salon-B', PHONE)).toBeNull()
  })
})
