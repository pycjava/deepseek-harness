/* Scratch probe — deleted before finishing. */
import { parsePowerLog, GameParser, LineError } from '../src/core/parser.ts'

const ts = 'D 10:00:00.0000'
const P = (msg: string) => `${ts} GameState.DebugPrintPower() - ${msg}`
const C = (msg: string) => `${ts} GameState.DebugPrintEntityChoices() - ${msg}`
const H = (msg: string) => `${ts} GameState.DebugPrintEntitiesChosen() - ${msg}`
const M = (msg: string) => `${ts} GameState.DebugPrintGame() - ${msg}`

const base = [
  P('CREATE_GAME'),
  P('    GameEntity EntityID=1'),
  P('        tag=ZONE value=PLAY'),
  P('    Player EntityID=2 PlayerID=1 GameAccountId=[hi=1 lo=123]'),
  P('        tag=CONTROLLER value=1'),
  P('    Player EntityID=3 PlayerID=2 GameAccountId=[hi=1 lo=456]'),
  P('        tag=CONTROLLER value=2'),
  P('FULL_ENTITY - Creating ID=4 CardID=CS2_234'),
  P('    tag=ZONE value=DECK'),
  P('    tag=CONTROLLER value=1'),
  P('    tag=ENTITY_ID value=4'),
]

// 1. mulligan flow: choices with controller resolution
const mulligan = [
  ...base,
  C('id=9 Player=BehEH#1234 TaskList=6 ChoiceType=MULLIGAN CountMin=0 CountMax=3'),
  C('  Source=GameEntity'),
  C('  Entities[0]=[name=UNKNOWN ENTITY [cardType=INVALID] id=4 zone=DECK zonePos=0 cardId= player=1]'),
  P('TAG_CHANGE Entity=2 tag=ZONE value=PLAY'),
  H('id=9 Player=BehEH#1234 EntitiesCount=1'),
  H('  Entities[0]=[name=x id=4 zone=DECK zonePos=0 cardId= player=1]'),
]
const r1 = parsePowerLog(mulligan)
console.log('1 mulligan:', r1.games.length, r1.skippedLines, r1.skippedGames)
const g1 = r1.games[0]
console.log('  friendly:', g1?.friendlyPlayerByShow, 'p2 tags:', g1?.findEntityById(2)?.kind)

// 2. chosen too many
const r2 = parsePowerLog([...base,
  H('id=1 Player=Foo EntitiesCount=1'),
  H('  Entities[0]=[name=x id=4 zone=DECK zonePos=0 cardId= player=1]'),
  H('  Entities[1]=[name=x id=4 zone=DECK zonePos=0 cardId= player=1]'),
])
console.log('2 chosen too many:', r2.games.length, r2.skippedLines)

// 3. meta bad
const r3 = parsePowerLog([...base, M('GameType=BAD'), M('NoEqualsHere'), M('PlayerID=1'), M('PlayerID=1, PlayerName=Foo')])
console.log('3 meta:', r3.games.length, r3.skippedLines)

// 4. blocks
const r4 = parsePowerLog([...base,
  P('BLOCK_START BlockType=TRIGGER Entity=1 EffectCardId= EffectIndex=0 Target=0 SubOption=-1'),
  P('BLOCK_START BlockType=ATTACK Entity=[name=x id=4 zone=DECK zonePos=0 cardId=CS2_234 player=1] EffectCardId= EffectIndex=-1 Target=0 SubOption=1 TriggerKeyword=CHARGE'),
  P('ACTION_START SubType=ATTACK Entity=4 EffectCardId= EffectIndex=0 Target=0'),
  P('ACTION_START Entity=4 SubType=ATTACK Index=0 Target=0'),
  P('ACTION_END'),
  P('BLOCK_END'),
  P('BLOCK_START BlockType=BOGUS Entity=1 EffectCardId= EffectIndex=0 Target=0'),
  P('BLOCK_START BlockType=GAME_RESET Entity=1 EffectCardId= EffectIndex=0 Target=0'),
  P('BLOCK_END'),
])
const c4 = r4.games[0]?.findEntityById(4)
console.log('4 blocks:', r4.games.length, r4.skippedLines, 'card4 after reset:', c4 && 'cardId' in c4 ? (c4 as { cardId: string | null }).cardId : null)

// 5. AI player friendly
const r5 = parsePowerLog([
  P('CREATE_GAME'),
  P('    GameEntity EntityID=1'),
  P('    Player EntityID=2 PlayerID=1 GameAccountId=[hi=0 lo=0]'),
  P('    Player EntityID=3 PlayerID=2 GameAccountId=[hi=1 lo=9]'),
  P('FULL_ENTITY - Creating ID=4 CardID='),
])
console.log('5 ai:', r5.games[0]?.friendlyPlayerByShow, r5.skippedLines)

// 6. errors
const r6 = parsePowerLog([...base,
  P('SHOW_ENTITY - Updating Entity=Bogus CardID=X1'),
])
console.log('6 show unresolved:', r6.games.length, r6.skippedGames)
const r7 = parsePowerLog([...base,
  P('TAG_CHANGE Entity=-1 tag=ZONE value=DECK'),
])
console.log('7 tag -1:', r7.games.length, r7.skippedGames)
const r8 = parsePowerLog([...base,
  P('TAG_CHANGE Entity=99 tag=ZONE value=DECK'),
])
console.log('8 unknown entity tagchange:', r8.games.length, r8.skippedGames)
const r9 = parsePowerLog([...base,
  P('CHANGE_ENTITY - Updating Entity=4 CardID=NEW_1'),
])
const c9 = r9.games[0]?.findEntityById(4)
console.log('9 change:', r9.games.length, c9 && 'cardId' in c9 ? (c9 as { cardId: string | null; revealed: boolean }).cardId : null)

// 10. hide entity
const r10 = parsePowerLog([...base,
  P('    SHOW_ENTITY - Updating Entity=4 CardID=CS2_234'),
  P('        tag=CONTROLLER value=1'),
  P('HIDE_ENTITY - Entity=[name=x id=4 zone=HAND zonePos=1 cardId=CS2_234 player=1] tag=ZONE value=DECK'),
  P('HIDE_ENTITY - Entity=[name=x id=4 zone=HAND zonePos=1 cardId=CS2_234 player=1] tag=ATK value=1'),
])
const c10 = r10.games[0]?.findEntityById(4)
console.log('10 hide:', r10.games.length, r10.skippedLines, c10 && 'revealed' in c10 ? (c10 as { revealed: boolean }).revealed : null, 'friendly', r10.games[0]?.friendlyPlayerByShow)

// 11. deferred tag changes
const deferred = [
  P('CREATE_GAME'),
  P('    GameEntity EntityID=1'),
  P('    Player EntityID=2 PlayerID=1 GameAccountId=[hi=1 lo=1]'),
  P('    Player EntityID=3 PlayerID=2 GameAccountId=[hi=1 lo=2]'),
  P('TAG_CHANGE Entity=PlayerA tag=TURN value=5'),
  P('TAG_CHANGE Entity=PlayerB tag=TURN value=6'),
  P('TAG_CHANGE Entity=PlayerA tag=ENTITY_ID value=2'),
  P('TAG_CHANGE Entity=PlayerB tag=ENTITY_ID value=3'),
]
const r11 = parsePowerLog(deferred)
console.log('11 deferred resolve:', r11.games.length, r11.skippedLines, r11.games[0]?.findEntityById(2)?.kind)
const r11b = parsePowerLog(deferred.slice(0, 7))
console.log('11b deferred unresolved:', r11b.games.length, r11b.skippedGames)

// 12. LAST_CARD_PLAYED
const r12 = parsePowerLog([...base,
  P('TAG_CHANGE Entity=PlayerB tag=LAST_CARD_PLAYED value=4'),
])
console.log('12 lcp resolved:', r12.games.length, r12.skippedLines, r12.games[0]?.findEntityById(2)?.kind)
const r12b = parsePowerLog([
  P('CREATE_GAME'),
  P('    GameEntity EntityID=1'),
  P('    Player EntityID=2 PlayerID=1 GameAccountId=[hi=1 lo=1]'),
  P('    Player EntityID=3 PlayerID=2 GameAccountId=[hi=1 lo=2]'),
  M('PlayerID=1, PlayerName=PlayerB'),
  P('FULL_ENTITY - Creating ID=4 CardID='),
  P('    tag=CONTROLLER value=1'),
  P('TAG_CHANGE Entity=PlayerB tag=LAST_CARD_PLAYED value=4'),
])
console.log('12b lcp deferred:', r12b.games.length, r12b.skippedLines, r12b.skippedGames)
const r12c = parsePowerLog([...base, P('TAG_CHANGE Entity=PlayerC tag=LAST_CARD_PLAYED value=99')])
console.log('12c lcp unknown controller:', r12c.skippedLines)

// 13. misc line shapes
const r13 = parsePowerLog([
  'not a timestamped line',
  `${ts} ================================================`,
  `${ts} plain text no parens`,
  `${ts} PowerTaskList.DebugPrintPower() - CREATE_GAME`,
  `${ts} GameState.DebugPrintOptions() - id=5`,
  P('CREATE_GAME extra'),       // bad CREATE_GAME → game stays null
  P('FULL_ENTITY - Creating ID=4 CardID='),  // no game → early return... includes CREATE_GAME? no
  P('CREATE_GAME'),
])
console.log('13 misc:', JSON.stringify({ g: r13.games.length, sl: r13.skippedLines, sg: r13.skippedGames }))

// 14. GameEntity mismatch + before game
const r14 = parsePowerLog([P('CREATE_GAME'), P('    GameEntity EntityID=2'), P('    Player EntityID=2 PlayerID=1 GameAccountId=[hi=1 lo=1]')])
console.log('14 mismatch:', r14.games.length, r14.skippedLines)
const gp = new GameParser()
try {
  gp.readLine(P('    GameEntity EntityID=1 CREATE_GAME'))
  console.log('14b no throw?!')
} catch (e) {
  console.log('14b before-game:', e instanceof LineError, (e as Error).message)
}

// 15. FULL_ENTITY updating on player entity
const r15 = parsePowerLog([...base,
  P('FULL_ENTITY - Updating [name=x id=2 zone=PLAY zonePos=0 cardId= player=1] CardID=NEW'),
])
console.log('15 full on player:', r15.games.length, r15.skippedGames)

// 16. tag before pending
const r16 = parsePowerLog([
  P('CREATE_GAME'),
  P('    GameEntity EntityID=1'),
  P('TAG_CHANGE Entity=1 tag=STATE value=RUNNING'),
  P('        tag=ZONE value=PLAY'),
])
console.log('16 tag no pending:', r16.games.length, r16.skippedLines)

// 17. unhandled power data + skips
const r17 = parsePowerLog([...base,
  P('ERROR: something bad'),
  P('META_DATA - MetaData=1 Data=2 Info[0]'),
  P('Info[0] - blah'),
  P('Targets[0]=blah'),
  P('Source'),
  P('Source=1'),
  P('BadOpcode - data'),
  P('SHUFFLE_DECK - x'),
])
console.log('17 misc power:', r17.games.length, r17.skippedLines)

// 18. choices errors
const r18 = parsePowerLog([...base,
  C('id=1 Player=Foo TaskList=6 CountMax=5'),
  C('bad header'),
  C('id=1 Player=Foo TaskList=6 ChoiceType=1 CountMin=0 CountMax=5'),
  C('id=1 Player=Foo TaskList=6 ChoiceType=BOGUS CountMin=0 CountMax=5'),
  C('  Source=BadSource'),
  C('  Entities[0]=notbracket'),
  C('  Entities[0]=[noid]'),
  C('  Whatever=1'),
  H('bad chosen'),
  H('  Entities[0]=[name=x id=4 zone=DECK zonePos=0 cardId= player=1]'),
  H('id=1 Player=Foo EntitiesCount=0'),
])
console.log('18 choices err:', r18.games.length, r18.skippedLines)
