import { describe, expect, it } from 'vitest'
import { transition } from './stateMachine'
import type { AssistantState } from './types'

const next = (state: AssistantState, type: Parameters<typeof transition>[1]['type']) =>
  transition(state, { type } as Parameters<typeof transition>[1])

describe('assistant state machine', () => {
  it('开启语音后进入待唤醒并启动唤醒监听', () => {
    expect(next('idle', 'ENABLE')).toEqual({
      state: 'standby',
      effects: ['startWake'],
    })
  })

  it('待唤醒命中唤醒词后建立会话、先打招呼并开始静默计时', () => {
    expect(next('standby', 'WAKE')).toEqual({
      state: 'listening',
      effects: ['startSession', 'playGreeting', 'scheduleT1'],
    })
  })

  it('待唤醒状态重复收到唤醒事件不会重复建会话', () => {
    expect(next('listening', 'WAKE')).toEqual({ state: 'listening', effects: [] })
  })

  it('对话中再次叫唤醒词：停掉当前轮次并重新招呼，回到对听状态', () => {
    expect(next('listening', 'REWAKE')).toEqual({
      state: 'listening',
      effects: ['cancelT1', 'cancelT2', 'cancelSession', 'playGreeting', 'scheduleT1'],
    })
  })

  it('提示中 / 结束中再次叫唤醒词同样重新唤醒', () => {
    expect(next('confirming', 'REWAKE')).toEqual({
      state: 'listening',
      effects: ['cancelT1', 'cancelT2', 'cancelSession', 'playGreeting', 'scheduleT1'],
    })
    expect(next('closing', 'REWAKE')).toEqual({
      state: 'listening',
      effects: ['cancelT1', 'cancelT2', 'cancelSession', 'playGreeting', 'scheduleT1'],
    })
  })

  it('待唤醒 / 未开启状态收到 REWAKE 不生效', () => {
    expect(next('standby', 'REWAKE')).toEqual({ state: 'standby', effects: [] })
    expect(next('idle', 'REWAKE')).toEqual({ state: 'idle', effects: [] })
  })

  it('静默超时后先提示，再等待回应', () => {
    expect(next('listening', 'T1_TIMEOUT')).toEqual({
      state: 'confirming',
      effects: ['cancelT1', 'playPrompt', 'scheduleT2'],
    })
  })

  it('提示期间用户开口会取消退出并回到对话', () => {
    expect(next('confirming', 'USER_SPEECH')).toEqual({
      state: 'listening',
      effects: ['cancelT2', 'scheduleT1'],
    })
  })

  it('宽限时间结束进入结束态并播结束语', () => {
    expect(next('confirming', 'T2_TIMEOUT')).toEqual({
      state: 'closing',
      effects: ['cancelT2', 'playFarewell'],
    })
  })

  it('本轮结束后回到待唤醒，仍然可以继续唤醒', () => {
    expect(next('closing', 'SESSION_DONE')).toEqual({
      state: 'standby',
      effects: ['endSession', 'startWake'],
    })
  })

  it('关闭总开关会清理会话与计时并停止监听', () => {
    expect(next('listening', 'DISABLE')).toEqual({
      state: 'idle',
      effects: ['cancelT1', 'cancelT2', 'cancelSession', 'stopWake'],
    })
  })

  it('对话中主动打断会回到待唤醒', () => {
    expect(next('listening', 'CANCEL')).toEqual({
      state: 'standby',
      effects: ['cancelT1', 'cancelT2', 'cancelSession', 'startWake'],
    })
  })

  it('助手开始回答会挂起静默计时，回答结束后重新计时', () => {
    expect(next('listening', 'ASSISTANT_BUSY')).toEqual({
      state: 'listening',
      effects: ['cancelT1'],
    })
    expect(next('listening', 'ASSISTANT_IDLE')).toEqual({
      state: 'listening',
      effects: ['scheduleT1'],
    })
  })

  it('提示态/结束态收到助手空闲不会重新拉起计时', () => {
    expect(next('confirming', 'ASSISTANT_IDLE')).toEqual({ state: 'confirming', effects: [] })
    expect(next('closing', 'ASSISTANT_IDLE')).toEqual({ state: 'closing', effects: [] })
  })

  it('会话异常会降级回待唤醒而不是卡死', () => {
    expect(next('confirming', 'ERROR')).toEqual({
      state: 'standby',
      effects: ['cancelT1', 'cancelT2', 'endSession', 'startWake'],
    })
  })

  it('未开启时收到唤醒事件不做任何事', () => {
    expect(next('idle', 'WAKE')).toEqual({ state: 'idle', effects: [] })
  })
})
