import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { connectStrap, strapAvailable } from './heart-strap.js'

/* A Web Bluetooth device, faked down to the events the transport actually listens for.
 * `emit` plays a packet the way a strap would; `drop` is the strap going out of range. */
function fakeStrap({ name = 'Polar H10' } = {}) {
  const listeners = new Map()
  const chListeners = new Map()
  const on = (map, k, fn) => { if (!map.has(k)) map.set(k, new Set()); map.get(k).add(fn) }
  const off = (map, k, fn) => map.get(k)?.delete(fn)
  const fire = (map, k, e) => [...(map.get(k) || [])].forEach(fn => fn(e))

  const ch = {
    notifying: false,
    addEventListener: (k, fn) => on(chListeners, k, fn),
    removeEventListener: (k, fn) => off(chListeners, k, fn),
    startNotifications: vi.fn(async () => { ch.notifying = true }),
    stopNotifications: vi.fn(async () => { ch.notifying = false })
  }
  const device = {
    name,
    gatt: {
      connected: false,
      connect: async () => { device.gatt.connected = true; return server },
      disconnect: () => { device.gatt.connected = false; fire(listeners, 'gattserverdisconnected') }
    },
    addEventListener: (k, fn) => on(listeners, k, fn),
    removeEventListener: (k, fn) => off(listeners, k, fn)
  }
  const server = {
    getPrimaryService: async () => ({ getCharacteristic: async () => ch })
  }
  return {
    device, ch,
    requested: [],
    emit: (...bytes) =>
      fire(chListeners, 'characteristicvaluechanged',
        { target: { value: new DataView(new Uint8Array(bytes).buffer) } }),
    drop: () => fire(listeners, 'gattserverdisconnected')
  }
}

let strap
beforeEach(() => {
  strap = fakeStrap()
  vi.stubGlobal('navigator', {
    bluetooth: { requestDevice: vi.fn(async opts => { strap.requested.push(opts); return strap.device }) }
  })
})
afterEach(() => vi.unstubAllGlobals())

describe('finding a strap', () => {
  it('is offered only where there is a radio to use', () => {
    expect(strapAvailable()).toBe(true)
    vi.stubGlobal('navigator', {})
    expect(strapAvailable()).toBe(false)
  })

  it('asks the chooser for heart-rate devices and not for everything in the room', async () => {
    await connectStrap(() => {})
    expect(strap.requested[0]).toEqual({ filters: [{ services: [0x180d] }] })
    expect(strap.ch.startNotifications).toHaveBeenCalled()
  })

  it('refuses rather than throwing something unrecognisable with no radio', async () => {
    vi.stubGlobal('navigator', {})
    await expect(connectStrap(() => {})).rejects.toThrow(/bluetooth/)
  })
})

describe('readings', () => {
  it('reports the rate in each packet', async () => {
    const seen = []
    await connectStrap(b => seen.push(b))
    strap.emit(0x00, 72)
    strap.emit(0x01, 0xb4, 0x00)
    expect(seen).toEqual([72, 180])
  })

  it('drops a reading from a strap that says it has lost contact', async () => {
    // It keeps transmitting when it slips, and what it sends is whatever it picks up off a
    // sleeve. Showing that as somebody's heart rate is worse than showing nothing.
    const seen = []
    await connectStrap(b => seen.push(b))
    strap.emit(0x06, 61)     // reports contact, has it
    strap.emit(0x04, 38)     // reports contact, lost it
    strap.emit(0x00, 62)     // cannot report contact — not the same as saying no
    expect(seen).toEqual([61, 62])
  })

  it('drops a reading no heart produced', async () => {
    const seen = []
    await connectStrap(b => seen.push(b))
    strap.emit(0x00, 0)
    strap.emit(0x00, 250)
    strap.emit(0x00, 58)
    expect(seen).toEqual([58])
  })
})

describe('letting go', () => {
  it('says so when the strap goes out of range', async () => {
    const lost = vi.fn()
    await connectStrap(() => {}, lost)
    strap.drop()
    expect(lost).toHaveBeenCalledTimes(1)
  })

  it('does not call that losing it when we are the ones disconnecting', async () => {
    // `gatt.disconnect()` fires the same event as a strap walking away, so an unhooked
    // listener would put "strap lost" on screen every time somebody tapped disconnect.
    const lost = vi.fn()
    const conn = await connectStrap(() => {}, lost)
    await conn.disconnect()
    expect(lost).not.toHaveBeenCalled()
    expect(strap.ch.stopNotifications).toHaveBeenCalled()
    expect(strap.device.gatt.connected).toBe(false)
  })

  it('stops listening once disconnected', async () => {
    const seen = []
    const conn = await connectStrap(b => seen.push(b))
    strap.emit(0x00, 70)
    await conn.disconnect()
    strap.emit(0x00, 80)
    expect(seen).toEqual([70])
  })

  it('carries the device name back for the sheet to show', async () => {
    expect((await connectStrap(() => {})).name).toBe('Polar H10')
  })
})
