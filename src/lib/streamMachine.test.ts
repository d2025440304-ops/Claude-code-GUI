/**
 * StreamMachine — 流式状态机单元测试
 */
import { describe, it, expect } from 'vitest'
import { reduce, transition, isInputLocked, isStreamActive } from './streamMachine'

describe('streamMachine', () => {
  describe('reduce', () => {
    it('IDLE + SEND → THINKING', () => {
      expect(reduce('IDLE', { type: 'SEND' })).toBe('THINKING')
    })
    it('IDLE + RESUME → STREAMING', () => {
      expect(reduce('IDLE', { type: 'RESUME' })).toBe('STREAMING')
    })
    it('THINKING + FIRST_CHUNK → STREAMING', () => {
      expect(reduce('THINKING', { type: 'FIRST_CHUNK' })).toBe('STREAMING')
    })
    it('THINKING + STOP_REQUESTED → INTERRUPTING', () => {
      expect(reduce('THINKING', { type: 'STOP_REQUESTED' })).toBe('INTERRUPTING')
    })
    it('THINKING + STOPPED → IDLE', () => {
      expect(reduce('THINKING', { type: 'STOPPED' })).toBe('IDLE')
    })
    it('THINKING + ERROR → ERROR', () => {
      expect(reduce('THINKING', { type: 'ERROR' })).toBe('ERROR')
    })
    it('STREAMING + STOP_REQUESTED → INTERRUPTING', () => {
      expect(reduce('STREAMING', { type: 'STOP_REQUESTED' })).toBe('INTERRUPTING')
    })
    it('STREAMING + STOPPED → IDLE', () => {
      expect(reduce('STREAMING', { type: 'STOPPED' })).toBe('IDLE')
    })
    it('STREAMING + ERROR → ERROR', () => {
      expect(reduce('STREAMING', { type: 'ERROR' })).toBe('ERROR')
    })
    it('INTERRUPTING + STOPPED → IDLE', () => {
      expect(reduce('INTERRUPTING', { type: 'STOPPED' })).toBe('IDLE')
    })
    it('INTERRUPTING + ERROR → ERROR', () => {
      expect(reduce('INTERRUPTING', { type: 'ERROR' })).toBe('ERROR')
    })
    it('ERROR + RESET → IDLE', () => {
      expect(reduce('ERROR', { type: 'RESET' })).toBe('IDLE')
    })
    it('ERROR + SEND → THINKING', () => {
      expect(reduce('ERROR', { type: 'SEND' })).toBe('THINKING')
    })
    it('invalid transition returns same state', () => {
      expect(reduce('IDLE', { type: 'STOP_REQUESTED' })).toBe('IDLE')
      expect(reduce('IDLE', { type: 'ERROR' })).toBe('IDLE')
      expect(reduce('STREAMING', { type: 'SEND' })).toBe('STREAMING')
    })
  })

  describe('transition', () => {
    it('compile-time valid transitions', () => {
      expect(transition('IDLE', 'SEND')).toBe('THINKING')
      expect(transition('THINKING', 'FIRST_CHUNK')).toBe('STREAMING')
    })
  })

  describe('isInputLocked', () => {
    it('locks during active processing', () => {
      expect(isInputLocked('THINKING')).toBe(true)
      expect(isInputLocked('STREAMING')).toBe(true)
      expect(isInputLocked('INTERRUPTING')).toBe(true)
    })
    it('unlocks when idle or error', () => {
      expect(isInputLocked('IDLE')).toBe(false)
      expect(isInputLocked('ERROR')).toBe(false)
    })
  })

  describe('isStreamActive', () => {
    it('matches isInputLocked semantics', () => {
      expect(isStreamActive('THINKING')).toBe(true)
      expect(isStreamActive('IDLE')).toBe(false)
    })
  })
})