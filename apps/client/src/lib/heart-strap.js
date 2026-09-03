/* A heart-rate strap, over Bluetooth, in whichever of the two runtimes this app is in.
 *
 * This is the one thing in docs/WEARABLES.md that an export file can never give us: a number
 * *during* a working set, rather than a summary of a session that finished an hour ago. It is
 * also the cheapest thing here to be honest about — the GATT Heart Rate Service is a standard,
 * so one implementation reaches a Polar, a Garmin, a Suunto, a Wahoo, every chest strap ever
 * made, and an Amazfit with Heart Rate Push switched on. No vendor SDK, no OAuth against a
 * company whose signup flow sanctions break, no cloud, nothing to pay anyone, ever.
 *
 * Not Apple Watch. Apple has no native broadcast mode, and telling people to install a
 * third-party watch app to fake one is not a feature.
 *
 * ## Two transports, one shape
 *
 * The PWA has Web Bluetooth, which Chrome on Android implements and Safari does not, so on an
 * iPhone this is simply absent — the same wall RELEASING.md already documents, for the same
 * reason. The native Android build cannot use Web Bluetooth at all: a Capacitor WebView is an
 * Android WebView, and Android WebView has never shipped the API. That build is also the one
 * most of this project's users install, so a web-only implementation would reach the smaller
 * half of the audience.
 *
 * Hence two transports behind `connectStrap`, and the packet decoder shared between them in
 * `@gymyar/domain` — the bytes are identical either way, and a second decoder is a second
 * place for a flag bit to be read wrong.
 */
import { MOBILE } from './mobile.js'
import { readHeartRateMeasurement, believableBpm } from '@gymyar/domain'

/* Heart Rate Service and its Measurement characteristic. Assigned numbers, not ours. */
const HR_SERVICE = 0x180d
const HR_MEASUREMENT = 0x2a37

/** Can this build reach a strap at all? Decides whether the UI offers to look for one. */
export const strapAvailable = () =>
  MOBILE || (typeof navigator !== 'undefined' && !!navigator.bluetooth)

/* A reading the caller should act on, or nothing.
 *
 * A strap that has slipped keeps transmitting — that is what makes it worth checking rather
 * than assuming. `contact === false` is the device saying so, and the number that comes with
 * it is whatever it could pick up off a sleeve, so it is dropped rather than shown. `null` is
 * a device that cannot tell, which is most of them, and is not the same answer. */
const usable = r => r && believableBpm(r.bpm) && r.contact !== false

/* ------------------------------------------------------------------ web ---- */

async function connectWeb(onReading, onLost) {
  // `filters` rather than `acceptAllDevices`: the chooser then lists heart-rate devices and
  // not every speaker and pair of earbuds in the room, and the page is granted access to this
  // service alone on the device the user picks.
  const device = await navigator.bluetooth.requestDevice({ filters: [{ services: [HR_SERVICE] }] })
  const lost = () => onLost()
  device.addEventListener('gattserverdisconnected', lost)

  const server = await device.gatt.connect()
  const ch = await (await server.getPrimaryService(HR_SERVICE)).getCharacteristic(HR_MEASUREMENT)
  const onValue = e => { const r = readHeartRateMeasurement(e.target.value); if (usable(r)) onReading(r.bpm) }
  ch.addEventListener('characteristicvaluechanged', onValue)
  await ch.startNotifications()

  return {
    name: device.name || '',
    async disconnect() {
      // The listener goes first: `gatt.disconnect()` fires the disconnect event, and reporting
      // a strap as lost when the user is the one who let go of it would put an error on screen
      // for a thing that went exactly as asked.
      device.removeEventListener('gattserverdisconnected', lost)
      ch.removeEventListener('characteristicvaluechanged', onValue)
      try { await ch.stopNotifications() } catch { /* already gone */ }
      if (device.gatt.connected) device.gatt.disconnect()
    }
  }
}

/* --------------------------------------------------------------- native ---- */

/* Gated on the raw env expression rather than on `MOBILE`, which is what actually keeps this
 * plugin out of the web bundle — see the note on the same pattern in health-connect.js for why
 * the constant does not do it and a guard in the caller does not either. */
const blePlugin = () => (import.meta.env.VITE_MOBILE === '1'
  ? import('@capacitor-community/bluetooth-le')
  : Promise.reject(new Error('no native bluetooth in this build')))

async function connectNative(onReading, onLost) {
  const { BleClient, numberToUUID } = await blePlugin()
  const svc = numberToUUID(HR_SERVICE)
  const chr = numberToUUID(HR_MEASUREMENT)

  // `androidNeverForLocation` is the difference between asking for Bluetooth and asking for
  // the user's location. Android ties BLE scanning to location permission unless the app
  // declares it will never derive location from a scan, which is true of us and is a claim
  // MOBILE.md's "nothing leaves the device" promise has to be able to make out loud. It is
  // also the permission a Cafe Bazaar reviewer will ask about first.
  await BleClient.initialize({ androidNeverForLocation: true })
  const device = await BleClient.requestDevice({ services: [svc] })
  await BleClient.connect(device.deviceId, () => onLost())
  await BleClient.startNotifications(device.deviceId, svc, chr, view => {
    const r = readHeartRateMeasurement(view)
    if (usable(r)) onReading(r.bpm)
  })

  return {
    name: device.name || '',
    async disconnect() {
      try { await BleClient.stopNotifications(device.deviceId, svc, chr) } catch { /* already gone */ }
      // The plugin's own disconnect callback fires from this, so the caller is told not to
      // treat what follows as the strap failing. Same reason as the web path above.
      try { await BleClient.disconnect(device.deviceId) } catch { /* already gone */ }
    }
  }
}

/* ------------------------------------------------------------------------- */

/**
 * Ask the user for a strap and start listening to it.
 *
 * Must be called from a gesture — both transports put a chooser on screen, and both platforms
 * refuse to open one that was not asked for by a tap.
 *
 * @param onReading  (bpm) => void, once per packet, roughly once a second
 * @param onLost     () => void, if the strap goes away on its own; never on `disconnect()`
 * @returns { name, disconnect() }
 */
export function connectStrap(onReading, onLost = () => {}) {
  if (!strapAvailable()) return Promise.reject(new Error('no bluetooth in this build'))
  return MOBILE ? connectNative(onReading, onLost) : connectWeb(onReading, onLost)
}
