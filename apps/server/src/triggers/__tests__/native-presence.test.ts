import { expect, mock, test } from 'bun:test'
import { TriggerPresenceReader, hasBluetoothAudio } from '../native-presence'

test('no opt-in starts no probes; repeated concurrent decisions share a bounded-fresh observation', async () => {
  const observation = { locked: false, idleSeconds: 15, bluetoothConnected: null }
  const probe = mock(async () => observation)
  const reader = new TriggerPresenceReader(probe)
  const t = new Date('2026-11-02T05:00:00Z')
  const signal = new AbortController().signal
  const settings = { enabled: true, idleMinutes: 5, bluetooth: false }
  expect(reader.read(undefined, t, signal)).toBeUndefined()
  expect(reader.read({ ...settings, enabled: false }, t, signal)).toBeUndefined()
  expect(probe).not.toHaveBeenCalled()
  const first = reader.read(settings, t, signal)
  expect(reader.read(settings, new Date(+t + 29_999), signal)).toBe(first)
  expect(await first).toEqual({ ...observation, observedAt: t.toISOString() })
  expect(await reader.read(settings, new Date(+t + 30_000), signal)).toMatchObject({
    observedAt: new Date(+t + 30_000).toISOString(),
  })
  expect(probe).toHaveBeenCalledTimes(2)
  await reader.read({ ...settings, bluetooth: true }, new Date(+t + 30_010), signal)
  expect(probe).toHaveBeenCalledTimes(3)
  expect(reader.read(settings, t, AbortSignal.abort())).toBeUndefined()
})

test('audio status only reports connected Bluetooth output devices and rejects unknown schemas', () => {
  const report = (devices: object[]) => ({ SPAudioDataType: [{ _items: devices }] })
  expect(hasBluetoothAudio({})).toBeNull()
  expect(hasBluetoothAudio({ SPAudioDataType: [] })).toBeNull()
  expect(
    hasBluetoothAudio(
      report([
        { coreaudio_device_transport: 'coreaudio_device_type_usb', coreaudio_device_output: 2 },
      ]),
    ),
  ).toBe(false)
  expect(
    hasBluetoothAudio(
      report([
        {
          _name: 'private name',
          coreaudio_device_transport: 'coreaudio_device_type_bluetooth',
          coreaudio_device_output: '2',
        },
      ]),
    ),
  ).toBe(true)
})
