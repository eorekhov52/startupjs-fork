import { it, describe, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import { afterEachTestGc, runGc } from './_helpers.js'
import { $, sub$ } from '../index.js'
import { get as _get } from '../orm/dataTree.js'
import connection from '../orm/connection.server.js'

function cbPromise (fn) {
  return new Promise((resolve, reject) => {
    fn((err, result) => err ? reject(err) : resolve(result))
  })
}

function afterEachTestGcShareDb () {
  afterEach(() => {
    assert.deepEqual(_get(['games']), {}, 'games collection is empty in signal\'s data tree')
    assert.equal(Object.keys(connection.collections?.games || {}).length, 0, 'no games in ShareDB\'s connection')
  })
}

describe('$sub() function', () => {
  afterEachTestGc()
  afterEachTestGcShareDb()

  it('signal for doc, subscribes to it, gets updates from direct sharedb data changes on client', async () => {
    const gameId = '_1'
    assert.equal(Object.keys(connection.collections?.games || {}).length, 0, 'no games initially in connection')
    const $game = await sub$($.games[gameId])
    assert.equal(Object.keys(connection.collections?.games || {}).length, 1, 'one game is in connection')
    const doc = connection.get('games', gameId)
    await cbPromise(cb => doc.create({ name: 'Game 1', players: 0 }, cb))
    assert.equal(doc.data.name, 'Game 1', 'share doc has name')
    assert.equal(doc.data.players, 0, 'share doc has 0 players')
    assert.equal($game.name.get(), 'Game 1', 'signal has name')
    assert.equal($game.players.get(), 0, 'signal has 0 players')
    assert.deepEqual(
      _get(['games']), { _1: { name: 'Game 1', players: 0 } },
      'signal data tree has one game in the games collection'
    )
    const promise = cbPromise(cb => doc.submitOp([{ p: ['players'], na: 1 }], cb))
    assert.equal($game.players.get(), 1, 'signal has 1 player. Updated synchronously')
    await promise
    assert.equal($game.players.get(), 1, 'signal still has 1 player. (after submitOp finished on the server)')
    assert.deepEqual($game.get(), { name: 'Game 1', players: 1 }, 'signal has all data')
    await cbPromise(cb => doc.del(cb))
    assert.equal($game.get(), undefined, 'signal has undefined data after doc is deleted')
  })

  it('destructured signals from doc keep the doc signal referenced to prevent it from being GC\'ed', async () => {
    const gameId = '_2'
    const { $name, $players } = await sub$($.games[gameId])
    assert.equal($name.get(), undefined, 'name is undefined')
    await runGc()
    const doc = connection.get('games', gameId)
    await cbPromise(cb => doc.create({ name: 'Game 2', players: 0 }, cb))
    await runGc()
    assert.equal($name.get(), 'Game 2', 'name is Game 2')
    assert.equal($players.get(), 0, 'players is 0')
    await cbPromise(cb => doc.submitOp([{ p: ['players'], na: 1 }], cb))
    assert.equal($players.get(), 1, 'players is 1')
    await runGc()
    assert.equal($players.get(), 1, 'players is still 1')
    await cbPromise(cb => doc.del(cb))
    assert.equal($name.get(), undefined, 'name is undefined')
    assert.equal($players.get(), undefined, 'players is undefined')
  })

  it('handles multiple sub$() calls for the same doc', async () => {
    const gameId3 = '_3'
    const gameId4 = '_4'
    const $game3 = await sub$($.games[gameId3])
    const $game4 = await sub$($.games[gameId4])
    const doc3 = connection.get('games', gameId3)
    const doc4 = connection.get('games', gameId4)
    await cbPromise(cb => doc3.create({ name: 'Game 3', players: 0 }, cb))
    await cbPromise(cb => doc4.create({ name: 'Game 4', players: 0 }, cb))
    assert.equal($game3.name.get(), 'Game 3', 'name is Game 3')
    assert.equal($game4.name.get(), 'Game 4', 'name is Game 4')
    const $game3Duplicate = await sub$($.games[gameId3])
    assert.equal($game3Duplicate.name.get(), 'Game 3', 'duplicate signal\'s name is Game 3')
    assert.equal($game3, $game3Duplicate, 'duplicate signal is the same as the original')
    await cbPromise(cb => doc3.del(cb))
    await cbPromise(cb => doc4.del(cb))
  })

  it.skip('doc: deep data also observable after .get()', async () => {
    const gameId = '_20'
    const $game = await sub$($.games[gameId])
    const game = $game.get()
    assert.equal(game.id, gameId)
    // TODO: When returning data from .get(), it should be wrapped into Proxy too
  })
})

describe('$sub() function. Modifying documents', () => {
  afterEachTestGc()
  afterEachTestGcShareDb()

  it('.set() to create document and modify it', async () => {
    const gameId = '_5'
    const doc = connection.get('games', gameId)
    assert.equal(doc.data, undefined, 'doc is initially undefined in sharedb')
    assert.deepEqual($.games.get(), {}, 'games collection is empty')
    const $game = await sub$($.games[gameId])
    assert.equal(doc.data, undefined, 'subscription itself does not create the doc in sharedb')
    assert.equal($game.get(), undefined, 'signal is undefined')
    assert.deepEqual($.games.get(), {}, 'games collection is still empty')
    await $game.set({ name: 'Game 5', players: 0 })
    assert.equal($game.name.get(), 'Game 5')
    assert.equal(doc.data.name, 'Game 5')
    assert.deepEqual($game.get(), { name: 'Game 5', players: 0 })
    assert.deepEqual(doc.data, { name: 'Game 5', players: 0 })
    assert.deepEqual($.games.get(), { _5: { name: 'Game 5', players: 0 } })
    await $game.name.set('Game 5 Magic')
    assert.equal($game.name.get(), 'Game 5 Magic')
    assert.equal(doc.data.name, 'Game 5 Magic')
    assert.deepEqual($game.get(), { name: 'Game 5 Magic', players: 0 })
    assert.deepEqual(doc.data, { name: 'Game 5 Magic', players: 0 })
  })

  it('.set() to deep modify document', async () => {
    const gameId = '_6'
    const doc = connection.get('games', gameId)
    const $game = await sub$($.games[gameId])
    await $game.set({ name: 'Game 6 Alt', players: 0 })
    assert.deepEqual($game.get(), { name: 'Game 6 Alt', players: 0 })
    assert.deepEqual(doc.data, { name: 'Game 6 Alt', players: 0 })
    assert.deepEqual($.games.get(), { _6: { name: 'Game 6 Alt', players: 0 } })
    await $game.set({ title: 'My Game', players: 5 })
    assert.deepEqual($game.get(), { title: 'My Game', players: 5 })
    assert.deepEqual(doc.data, { title: 'My Game', players: 5 })
    assert.deepEqual($.games.get(), { _6: { title: 'My Game', players: 5 } })
  })

  it('.del() to delete document', async () => {
    const gameId = '_7'
    const doc = connection.get('games', gameId)
    const $game = await sub$($.games[gameId])
    await $game.set({ name: 'Game 7', players: 0 })
    assert.deepEqual($game.get(), { name: 'Game 7', players: 0 })
    assert.deepEqual(doc.data, { name: 'Game 7', players: 0 })
    await $game.del()
    assert.equal($game.get(), undefined)
    assert.equal(doc.data, undefined)
  })

  it('.set(undefined) on document should delete it', async () => {
    const gameId = '_8'
    const doc = connection.get('games', gameId)
    const $game = await sub$($.games[gameId])
    await $game.set({ name: 'Game 8', players: 0 })
    assert.deepEqual($game.get(), { name: 'Game 8', players: 0 })
    assert.deepEqual(doc.data, { name: 'Game 8', players: 0 })
    await $game.set(undefined)
    assert.equal($game.get(), undefined)
    assert.equal(doc.data, undefined)
  })

  it('.del() on subpath should delete the subpath', async () => {
    const gameId = '_9'
    const doc = connection.get('games', gameId)
    const $game = await sub$($.games[gameId])
    await $game.set({ name: 'Game 9', players: 0 })
    assert.deepEqual($game.get(), { name: 'Game 9', players: 0 })
    assert.deepEqual(doc.data, { name: 'Game 9', players: 0 })
    await $game.name.del()
    assert.deepEqual($game.get(), { players: 0 })
    assert.deepEqual(doc.data, { players: 0 })
  })

  it('.set() on subpath on non-existing document should throw an error', async () => {
    const gameId = '_10'
    const $game = await sub$($.games[gameId])
    await assert.rejects(async () => {
      await $game.name.set('Game 10')
    }, { message: /Can't set a value to a subpath of a document which doesn't exist/ })
  })
})

describe.skip('$sub() function. Queries', () => {
  it('query', async () => {
    const $games = await sub$($.games, { active: true })
    assert.equal($games.get().length, 2)
  })

  it('query should be iterable', async () => {
    const $games = await sub$($.games, { active: true })
    assert.equal([...$games].length, 2)
  })

  it('query should support .map()', async () => {
    const $games = await sub$($.games, { active: true })
    assert.equal($games.map($game => $game.id.get()).sort().join(','), '_1,_2')
  })

  it('async reaction', async () => {
    const $value = await sub$(async () => {
      await new Promise(resolve => setTimeout(resolve, 10))
      return 42
    })
    assert.equal($value.get(), undefined)
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal($value.get(), 42)
  })
})
