import { describe, expect, it } from 'bun:test'
import { readString, readStringArray } from '../yaml'

describe('readString', () => {
  it('returns the string when key exists and value is a string', () => {
    expect(readString({ name: 'hello' }, 'name')).toBe('hello')
  })

  it('trims whitespace from the returned string', () => {
    expect(readString({ name: '  hello  ' }, 'name')).toBe('hello')
  })

  it('returns undefined when key does not exist', () => {
    expect(readString({ name: 'hello' }, 'missing')).toBeUndefined()
  })

  it('returns undefined when value is a number', () => {
    expect(readString({ count: 42 }, 'count')).toBeUndefined()
  })

  it('returns undefined when value is a boolean', () => {
    expect(readString({ flag: true }, 'flag')).toBeUndefined()
  })

  it('returns undefined when value is an empty string', () => {
    expect(readString({ name: '' }, 'name')).toBeUndefined()
  })

  it('returns undefined when value is a whitespace-only string', () => {
    expect(readString({ name: '   ' }, 'name')).toBeUndefined()
  })

  it('returns the first matching key among multiple aliases', () => {
    const raw = { alias: 'first', name: 'second' }
    expect(readString(raw, 'alias', 'name')).toBe('first')
  })

  it('falls back to later alias when earlier key is missing', () => {
    const raw = { name: 'value' }
    expect(readString(raw, 'missing', 'name')).toBe('value')
  })
})

describe('readStringArray', () => {
  it('returns the array when key exists and value is a string array', () => {
    expect(readStringArray({ tags: ['a', 'b'] }, 'tags')).toEqual(['a', 'b'])
  })

  it('trims whitespace from array items', () => {
    expect(readStringArray({ tags: ['  a  ', ' b '] }, 'tags')).toEqual(['a', 'b'])
  })

  it('returns undefined when key does not exist', () => {
    expect(readStringArray({ tags: ['a'] }, 'missing')).toBeUndefined()
  })

  it('returns undefined when value is not an array (string)', () => {
    expect(readStringArray({ tags: 'not-array' }, 'tags')).toBeUndefined()
  })

  it('returns undefined when value is not an array (number)', () => {
    expect(readStringArray({ tags: 123 }, 'tags')).toBeUndefined()
  })

  it('filters out non-string elements from the array', () => {
    expect(readStringArray({ tags: ['a', 42, 'b', true, 'c'] }, 'tags')).toEqual(['a', 'b', 'c'])
  })

  it('filters out empty and whitespace-only strings', () => {
    expect(readStringArray({ tags: ['a', '', '   ', 'b'] }, 'tags')).toEqual(['a', 'b'])
  })

  it('uses the first matching key among multiple aliases', () => {
    const raw = { labels: ['x'], tags: ['y'] }
    expect(readStringArray(raw, 'labels', 'tags')).toEqual(['x'])
  })
})
