import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseText } from '../src/client/hear.js'

test('parses commands and keeps prose as caption', () => {
  const s = parseText('MAP https://a/map.json\nMEDIA https://a/m.json\nPOLICY https://a/p.json\nSTREET x.org/sq\nHEIGHT 600\nThe street.')
  assert.equal(s.map, 'https://a/map.json'); assert.equal(s.media, 'https://a/m.json'); assert.equal(s.policy, 'https://a/p.json')
  assert.equal(s.street, 'x.org/sq'); assert.equal(s.height, 600); assert.deepEqual(s.caption, ['The street.'])
})
test('guards undefined text and small heights', () => {
  assert.equal(parseText(undefined).map, ''); assert.equal(parseText('HEIGHT 10').height, 240)
})
