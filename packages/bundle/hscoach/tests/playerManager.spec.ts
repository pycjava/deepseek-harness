/**
 * PlayerManager 单元测试：名字/实体/玩家 id 三路映射的注册、合并、
 * 冲突与推断分支。
 */
import { describe, expect, it } from 'vitest'
import {
  PlayerManager,
  PlayerManagerError,
  UNKNOWN_HUMAN_PLAYER,
} from '../src/core/playerManager.ts'

describe('PlayerManager', () => {
  it('全名先注册，后到的裸名经别名映射合并到同一引用', () => {
    const manager = new PlayerManager()
    const full = manager.createOrUpdatePlayer({ name: 'Rexxar#1234' })
    const bare = manager.createOrUpdatePlayer({ name: 'Rexxar' })
    expect(bare).toBe(full)
    expect(full.name).toBe('Rexxar#1234')
  })

  it('裸名先注册时后到的全名走推断分支（独立引用 + 推断实体位）', () => {
    const manager = new PlayerManager()
    const bare = manager.createOrUpdatePlayer({ name: 'Rexxar' })
    const full = manager.createOrUpdatePlayer({ name: 'Rexxar#1234' })
    expect(full).not.toBe(bare)
    expect(full.entityId).toBe(2)
  })

  it('UNKNOWN HUMAN PLAYER 不进名字表；后到的真名是独立引用', () => {
    const manager = new PlayerManager()
    const unknown = manager.createOrUpdatePlayer({ name: UNKNOWN_HUMAN_PLAYER })
    const real = manager.createOrUpdatePlayer({ name: '真人', entityId: 4 })
    expect(real).not.toBe(unknown)
    expect(real.entityId).toBe(4)
    expect(unknown.name).toBe(UNKNOWN_HUMAN_PLAYER)
  })

  it('getByEntityId / registerController / getControllerByEntityId 记账', () => {
    const manager = new PlayerManager()
    const player = manager.createOrUpdatePlayer({ name: 'A', entityId: 8, playerId: 1 })
    expect(manager.getByEntityId(8)).toBe(player)
    manager.registerController(100, 1)
    expect(manager.getControllerByEntityId(100)).toBe(1)
    expect(manager.getControllerByEntityId(999)).toBeUndefined()
  })

  it('同实体 id 重复注册幂等，冲突抛错', () => {
    const manager = new PlayerManager()
    manager.createOrUpdatePlayer({ name: 'A', entityId: 2 })
    expect(manager.createOrUpdatePlayer({ name: 'A', entityId: 2 }).entityId).toBe(2)
    expect(() => manager.createOrUpdatePlayer({ name: 'A', entityId: 3 })).toThrow(PlayerManagerError)
  })

  it('同 player id 冲突抛错', () => {
    const manager = new PlayerManager()
    manager.createOrUpdatePlayer({ name: 'A', playerId: 1 })
    expect(() => manager.createOrUpdatePlayer({ name: 'A', playerId: 2 })).toThrow(PlayerManagerError)
  })

  it('名字冲突（非 AI 玩家）抛错', () => {
    const manager = new PlayerManager()
    manager.createOrUpdatePlayer({ name: 'A', entityId: 2 })
    expect(() => manager.createOrUpdatePlayer({ name: 'B', entityId: 2 })).toThrow(PlayerManagerError)
  })

  it('AI 玩家可改名（旅店老板分支）', () => {
    const manager = new PlayerManager()
    const ai = manager.createOrUpdatePlayer({ name: '旅店老板', entityId: 2, isAi: true })
    const renamed = manager.createOrUpdatePlayer({ name: '新老板', entityId: 2 })
    expect(renamed).toBe(ai)
    expect(ai.name).toBe('新老板')
  })

  it('isAi 传导 aiPlayer；后续同实体改名走 AI 分支', () => {
    const manager = new PlayerManager()
    manager.createOrUpdatePlayer({ name: 'X', isAi: true })
    // 同实体位（无显式 id）合并进 AI 引用
    const later = manager.createOrUpdatePlayer({ name: 'Y', isAi: true })
    expect(later.name).not.toBe('X')
  })

  it('名字先注册后补实体 id：合并进同一引用并触发回调', () => {
    const manager = new PlayerManager()
    const assigned: number[] = []
    manager.onEntityIdAssigned = ref => assigned.push(ref.entityId ?? -1)
    const byName = manager.createOrUpdatePlayer({ name: 'Z' })
    expect(assigned).toEqual([])
    const merged = manager.createOrUpdatePlayer({ name: 'Z', entityId: 6 })
    expect(merged).toBe(byName)
    expect(byName.entityId).toBe(6)
    expect(assigned).toEqual([6])
  })

  it('player id 通道互补合并：名字引用经 playerId 获得实体 id', () => {
    const manager = new PlayerManager()
    const assigned: number[] = []
    manager.onEntityIdAssigned = ref => assigned.push(ref.entityId ?? -1)
    const right = manager.createOrUpdatePlayer({ name: 'R' })
    const merged = manager.createOrUpdatePlayer({ name: 'R', entityId: 3, playerId: 5 })
    expect(merged).toBe(right)
    expect(right.entityId).toBe(3)
    expect(right.playerId).toBe(5)
    expect(assigned).toEqual([3])
  })

  it('仅注册一个名字时可推断另一个实体位（实体 2/3 协议常量）', () => {
    const manager = new PlayerManager()
    manager.createOrUpdatePlayer({ name: 'P1', entityId: 2 })
    const other = manager.createOrUpdatePlayer({ name: 'P2' })
    expect(other.entityId).toBe(3)
    expect(manager.getByEntityId(3)).toBe(other)
  })

  it('推断目标实体位已被无名引用占用时并入该引用', () => {
    const manager = new PlayerManager()
    manager.createOrUpdatePlayer({ name: 'A', entityId: 3 })
    const anonymous = manager.createOrUpdatePlayer({ entityId: 2, playerId: 9 })
    const inferred = manager.createOrUpdatePlayer({ name: 'B' })
    expect(inferred).toBe(anonymous)
    expect(anonymous.name).toBe('B')
    expect(anonymous.playerId).toBe(9)
  })

  it('名字表多于一个时不做推断，新名字独立注册', () => {
    const manager = new PlayerManager()
    manager.createOrUpdatePlayer({ name: 'P1', entityId: 3 })
    manager.createOrUpdatePlayer({ name: 'Existing', entityId: 2 })
    const inferred = manager.createOrUpdatePlayer({ name: 'NewName' })
    expect(inferred.entityId).toBeNull()
    expect(inferred.name).toBe('NewName')
  })

  it('合并时实体 id 不一致抛错', () => {
    const manager = new PlayerManager()
    manager.createOrUpdatePlayer({ name: 'A', entityId: 2 })
    manager.createOrUpdatePlayer({ name: 'B', entityId: 3 })
    expect(() => manager.createOrUpdatePlayer({ name: 'A', entityId: 3, playerId: 9 })).toThrow(PlayerManagerError)
  })

  it('合并时 player id 不一致抛错', () => {
    const manager = new PlayerManager()
    manager.createOrUpdatePlayer({ name: 'A', entityId: 2, playerId: 1 })
    manager.createOrUpdatePlayer({ name: 'B', entityId: 3, playerId: 2 })
    expect(() => manager.createOrUpdatePlayer({ name: 'A', playerId: 2 })).toThrow(PlayerManagerError)
  })
})

describe('PlayerManager 合并矩阵补齐', () => {
  it('playerId 先行引用与名字引用经实体 id 合并（existing 分支）', () => {
    const manager = new PlayerManager()
    const assigned: number[] = []
    manager.onEntityIdAssigned = ref => assigned.push(ref.entityId ?? -1)
    const byPid = manager.createOrUpdatePlayer({ entityId: 5, playerId: 9 })
    const byName = manager.createOrUpdatePlayer({ name: '合并者' })
    expect(byName).not.toBe(byPid)
    const merged = manager.createOrUpdatePlayer({ name: '合并者', entityId: 5 })
    expect(merged).toBe(byName)
    // 名字引用并入既有实体 5 的引用并回调
    expect(byName.entityId).toBe(5)
    expect(assigned).toContain(5)
  })

  it('同实体 id 换名抛冲突（非 AI 引用）', () => {
    const manager = new PlayerManager()
    manager.createOrUpdatePlayer({ name: 'A', entityId: 2 })
    expect(() => manager.createOrUpdatePlayer({ name: 'B', entityId: 2 })).toThrow(PlayerManagerError)
  })

  it('AI 引用经名字再次注册时改名不抛', () => {
    const manager = new PlayerManager()
    const ai = manager.createOrUpdatePlayer({ name: '老板', entityId: 2, isAi: true })
    const renamed = manager.createOrUpdatePlayer({ name: '新老板', entityId: 2, isAi: true })
    expect(renamed).toBe(ai)
    expect(ai.name).toBe('新老板')
  })
})

describe('PlayerManager 合并级冲突', () => {
  it('经 player-id 合并触发实体 id 冲突', () => {
    const manager = new PlayerManager()
    manager.createOrUpdatePlayer({ entityId: 2, playerId: 5 })
    manager.createOrUpdatePlayer({ name: 'N' })
    expect(() => manager.createOrUpdatePlayer({ name: 'N', entityId: 3, playerId: 5 })).toThrow(PlayerManagerError)
  })

  it('经实体合并触发 player id 冲突', () => {
    const manager = new PlayerManager()
    manager.createOrUpdatePlayer({ entityId: 2, playerId: 5 })
    manager.createOrUpdatePlayer({ name: 'M', playerId: 6 })
    expect(() => manager.createOrUpdatePlayer({ name: 'M', entityId: 2 })).toThrow(PlayerManagerError)
  })

  it('playerId 互补三步合并触发双侧回调', () => {
    const manager = new PlayerManager()
    const assigned: number[] = []
    manager.onEntityIdAssigned = ref => assigned.push(ref.entityId ?? -1)
    manager.createOrUpdatePlayer({ playerId: 5 })
    const named = manager.createOrUpdatePlayer({ name: 'R' })
    const merged = manager.createOrUpdatePlayer({ name: 'R', entityId: 3, playerId: 5 })
    expect(merged).toBe(named)
    expect(named.entityId).toBe(3)
    expect(assigned.filter(id => id === 3).length).toBe(2)
  })

  it('同名 # 别名前缀重复注册不覆盖首个别名', () => {
    const manager = new PlayerManager()
    manager.createOrUpdatePlayer({ name: 'Rexxar#1', entityId: 2 })
    manager.createOrUpdatePlayer({ name: 'Rexxar#2', entityId: 3 })
    // 'Rexxar' 别名保持指向首个全名
    const bare = manager.createOrUpdatePlayer({ name: 'Rexxar#1' })
    expect(bare.entityId).toBe(2)
  })

  it('UNKNOWN HUMAN PLAYER 作为后到名不触发冲突', () => {
    const manager = new PlayerManager()
    manager.createOrUpdatePlayer({ name: '真名', entityId: 2 })
    const ref = manager.createOrUpdatePlayer({ name: UNKNOWN_HUMAN_PLAYER, entityId: 2 })
    expect(ref.name).toBe('真名')
  })
})

describe('PlayerManager 终批分支', () => {
  it('双向合并：左侧无 pid 获右侧 pid；双侧无名保持无名', () => {
    const manager = new PlayerManager()
    manager.createOrUpdatePlayer({ entityId: 4 })
    manager.createOrUpdatePlayer({ playerId: 6 })
    const merged = manager.createOrUpdatePlayer({ entityId: 4, playerId: 6 })
    expect(merged.entityId).toBe(4)
    expect(merged.playerId).toBe(6)
    expect(merged.name).toBeNull()
  })

  it('右侧无名无 id 的合并不传播名字（双向空）', () => {
    const manager = new PlayerManager()
    manager.createOrUpdatePlayer({ name: '左名', playerId: 7 })
    manager.createOrUpdatePlayer({ name: '右名', entityId: 9 })
    const merged = manager.createOrUpdatePlayer({ name: '右名', playerId: 7 })
    expect(merged.entityId).toBe(9)
    expect(merged.name).toBe('右名')
  })
})

describe('PlayerManager 覆盖收尾', () => {
  it('别名已存在时跳过注册（需名字表大小 ≠ 1 避开推断）', () => {
    const manager = new PlayerManager()
    manager.createOrUpdatePlayer({ name: '先行者#1', entityId: 2 })
    manager.createOrUpdatePlayer({ name: '第三者', entityId: 5 })
    // '先行者' 别名已存在 → 第二个 # 号名跳过别名写入
    manager.createOrUpdatePlayer({ name: '先行者#2', entityId: 6 })
    const bare = manager.createOrUpdatePlayer({ name: '先行者#1' })
    expect(bare.entityId).toBe(2)
  })

  it('双侧实体 id 皆空的合并不传播 id', () => {
    const manager = new PlayerManager()
    manager.createOrUpdatePlayer({ playerId: 6 })
    manager.createOrUpdatePlayer({ name: '无名氏' })
    const merged = manager.createOrUpdatePlayer({ name: '无名氏', playerId: 6 })
    expect(merged.entityId).toBeNull()
    expect(merged.name).toBe('无名氏')
  })

  it('实体先行引用合并名字引用：左侧获得 pid、名字双向传播', () => {
    const manager = new PlayerManager()
    manager.createOrUpdatePlayer({ entityId: 4 })
    manager.createOrUpdatePlayer({ name: '右名' })
    const merged = manager.createOrUpdatePlayer({ name: '右名', entityId: 4 })
    expect(merged.entityId).toBe(4)
    expect(merged.name).toBe('右名')
  })
})
