// The Push/Pull/Legs starter plan. Shared by the "Load starter plan" action in Settings
// and by the demo build, which seeds a history on top of exactly these routines.
import { uid } from './format.js'

const SPEC = [
  ['Push Day', 'barbell', [['0025', 4, 8], ['0047', 3, 10], ['0426', 3, 10], ['0334', 3, 12], ['0241', 3, 12], ['0251', 3, 10]]],
  ['Pull Day', 'pullup', [['2330', 4, 10], ['0027', 4, 8], ['1323', 3, 10], ['0031', 3, 10], ['0313', 3, 12]]],
  ['Leg Day', 'legs', [['0043', 4, 8], ['0085', 3, 10], ['0739', 3, 12], ['0585', 3, 12], ['0586', 3, 12], ['0605', 4, 15]]]
]

// Fresh routine objects (new ids) — [push, pull, legs].
export const starterRoutines = () =>
  SPEC.map(([name, emoji, list]) => ({ id: uid(), name, emoji, ex: list.map(([id, sets, reps]) => ({ id, sets, reps, weight: 0 })) }))

// Kia's 3-day split: Back + Triceps / Chest + Biceps / Shoulders + Legs.
// Every session opens with 10 min on the bike and closes with 15–20 min of treadmill
// intervals, so both are real cardio entries in each routine, not a note nobody reads.
// Entry shapes: [id, sets, reps] for a lift, ['cardio', id, min, speed] for cardio.
// A letter in the fourth slot links a lift into a superset with its neighbour carrying the
// same letter — the routine editor's `sg` link, written ahead of time.
const BIKE = ['cardio', '2138', 10, 20]
const TREADMILL = ['cardio', '3666', 20, 8]
export const SPLIT_SPEC = [
  ['Back + Triceps', 'pullup', [
    BIKE,
    ['2330', 3, 12],          // wide-grip lat pulldown
    ['1350', 3, 10],          // machine row, parallel grip
    ['0327', 3, 8],           // chest-supported dumbbell row on incline bench
    ['0218', 3, 12],          // seated cable row, wide grip
    ['2616', 3, 10],          // V-bar pulldown
    ['0180', 3, 12],          // low cable row
    ['0581', 3, 10],          // back machine (high row)
    ['0241', 3, 12],          // triceps pushdown, V-bar
    ['0060', 3, 10],          // lying barbell triceps extension
    ['0607', 3, 10, 'a'],     // seated triceps machine  ┐ superset
    ['1451', 3, 10, 'a'],     // machine dips            ┘
    ['0489', 3, 12],          // back extension
    ['0243', 3, 25],          // obliques (cable twist)
    TREADMILL
  ]],
  ['Chest + Biceps', 'barbell', [
    BIKE,
    ['0577', 3, 12],          // machine chest press
    ['0314', 3, 10],          // incline dumbbell press
    ['0033', 3, 10, 'a'],     // decline barbell press   ┐ superset
    ['1300', 3, 10, 'a'],     // decline machine press   ┘
    ['0155', 3, 12],          // cable crossover, high to low
    ['0596', 3, 12, 'b'],     // pec-deck fly            ┐ superset
    ['1451', 3, 8, 'b'],      // machine dips            ┘
    ['0868', 3, 10],          // cable biceps curl (half + full reps)
    ['0372', 3, 10],          // dumbbell preacher curl
    ['1641', 3, 10, 'c'],     // seated cable curl       ┐ superset
    ['0313', 3, 8, 'c'],      // dumbbell hammer curl    ┘
    ['0620', 3, 25, 'd'],     // lower abs (leg raise)   ┐ superset
    ['0635', 3, 25, 'd'],     // obliques (crunch)       ┘
    ['0126', 3, 12],          // wrist & forearm curl
    TREADMILL
  ]],
  ['Shoulders + Legs', 'legs', [
    BIKE,
    ['0334', 3, 10],          // dumbbell lateral raise
    ['0766', 3, 10],          // smith machine shoulder press
    ['0162', 3, 12],          // cable front raise
    ['0405', 3, 12],          // dumbbell shoulder press (or Arnold)
    ['0203', 3, 12],          // face pull, rope (cable rear-delt row with rope)
    ['0585', 3, 12, 'a'],     // leg extension           ┐ superset
    ['0599', 3, 12, 'a'],     // seated leg curl         ┘
    ['0743', 3, 10],          // hack squat machine
    ['0739', 3, 10, 'b'],     // leg press               ┐ superset
    ['0598', 3, 10, 'b'],     // adductor machine        ┘
    ['0594', 3, 12],          // seated calf raise
    ['0595', 3, 25],          // ab machine
    TREADMILL
  ]]
]

// Fresh routine objects (new ids) — [back+tri, chest+bi, shoulders+legs].
export const kiaSplitRoutines = () =>
  SPLIT_SPEC.map(([name, emoji, list]) => {
    const groups = {}
    const ex = list.map(e => {
      if (e[0] === 'cardio') return { id: e[1], sets: 1, min: e[2], speed: e[3] }
      const [id, sets, reps, g] = e
      const o = { id, sets, reps, weight: 0 }
      if (g) o.sg = groups[g] || (groups[g] = 'sg' + uid())
      return o
    })
    return { id: uid(), name, emoji, ex }
  })
