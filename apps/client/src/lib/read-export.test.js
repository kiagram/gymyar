import { describe, it, expect } from 'vitest'
import { zipSync, strToU8 } from 'fflate'
import { readExport } from './read-export.js'

const TZ = '+0330'
const XML = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_IR">
<Record type="HKQuantityTypeIdentifierBodyMass" unit="kg" startDate="2026-01-10 07:30:00 ${TZ}" value="78.4"/>
<Record type="HKQuantityTypeIdentifierHeartRate" unit="count/min" startDate="2026-01-10 18:05:00 ${TZ}" value="150"/>
<Record type="HKQuantityTypeIdentifierHeartRate" unit="count/min" startDate="2026-01-10 18:10:00 ${TZ}" value="170"/>
<Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="30" durationUnit="min" totalDistance="7.5" totalDistanceUnit="km" startDate="2026-01-10 18:00:00 ${TZ}" endDate="2026-01-10 18:30:00 ${TZ}"/>
</HealthData>
`

// The clinical document Apple ships beside the export. Valid XML, holds none of this, and
// sorts first — so anything picking "the first .xml in the archive" picks the wrong one.
const CDA = '<?xml version="1.0"?>\n<ClinicalDocument><title>Health</title></ClinicalDocument>\n'

const file = (name, bytes) => new File([bytes], name)
const appleZip = (extra = {}) => zipSync({
  'apple_health_export': {
    'export_cda.xml': strToU8(CDA),
    'export.xml': strToU8(XML),
    ...extra
  }
})

describe('reading a picked export', () => {
  it('opens Apple s zip and reads the export inside it', async () => {
    const p = await readExport(file('export.zip', appleZip()), { unit: 'kg' })
    expect(p.kind).toBe('health')
    expect(p.workouts).toHaveLength(1)
    expect(p.workouts[0].hr).toEqual({ n: 2, avg: 160, min: 150, max: 170 })
    expect(p.bodyweight).toHaveLength(1)
  })

  it('picks export.xml and not the clinical document beside it', async () => {
    // Both are XML and the CDA sorts first in the archive. Reading that one would produce
    // "unrecognised" against a file that plainly holds a year of training.
    const p = await readExport(file('export.zip', appleZip()), { unit: 'kg' })
    expect(p.error).toBeUndefined()
    expect(p.source).toBe('Apple Health')
  })

  it('is not fooled by a file the share sheet renamed', async () => {
    // A zip arriving from an iPhone share sheet is routinely called something else. The four
    // magic bytes decide what it is, not the name.
    const p = await readExport(file('Health Data.txt', appleZip()), { unit: 'kg' })
    expect(p.kind).toBe('health')
  })

  it('still reads a bare xml that somebody unzipped themselves', async () => {
    const p = await readExport(file('export.xml', strToU8(XML)), { unit: 'kg' })
    expect(p.kind).toBe('health')
    expect(p.workouts).toHaveLength(1)
  })

  it('still reads the CSV exports this has always taken', async () => {
    const csv = 'Date,Exercise,Weight,Reps\n2026-01-12,Bench Press,60,10\n'
    const p = await readExport(file('strong.csv', strToU8(csv)), { unit: 'kg' })
    expect(p.kind).toBe('workouts')
    expect(p.sets).toBe(1)
  })

  it('says so when the archive holds no export', async () => {
    const junk = zipSync({ 'photos/cat.txt': strToU8('meow') })
    await expect(readExport(file('export.zip', junk), { unit: 'kg' })).rejects.toThrow(/export\.xml/)
  })

  it('reports every phase it goes through, in order', async () => {
    const seen = []
    await readExport(file('export.zip', appleZip()), { unit: 'kg' }, p => {
      if (seen[seen.length - 1] !== p.phase) seen.push(p.phase)
      expect(p.pct).toBeGreaterThanOrEqual(0)
      expect(p.pct).toBeLessThanOrEqual(1)
    })
    expect(seen).toEqual(['read', 'unzip', 'parse'])
  })

  it('does not claim to unzip a file that was never zipped', async () => {
    const seen = new Set()
    await readExport(file('export.xml', strToU8(XML)), { unit: 'kg' }, p => seen.add(p.phase))
    expect([...seen]).toEqual(['read', 'parse'])
  })
})
