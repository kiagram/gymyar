/* The planner's rationale sentences, in the languages the API serves.
 *
 * Everything else the app says is translated on the client, from the locale packs it already
 * loads. These few sentences cannot be: they end up inside a note that is *written to the
 * database* when a coach sends a proposal, so the language has to be decided at write time by
 * the server, in the language of the person who will read it.
 *
 * That is the whole reason this file exists, and the reason it is this small. Anything the
 * client renders belongs in apps/client/src/locales, not here — see packages/domain/messages.js.
 *
 * Keys are the English source strings, the same convention the locale packs use.
 */
const FA = {
  'Cut the rep target so the current load is reachable again, rather than deloading and climbing back through the same wall.':
    'هدف تکرار را کم کردیم تا وزنه فعلی دوباره در دسترس باشد، به‌جای اینکه دیلود کنیم و همان مسیر را دوباره بالا بیاییم.',
  'Added a set: the sessions are ending with too much left, and more work is the cheaper answer than a bigger weight jump.':
    'یک ست اضافه شد: جلسه‌ها با توان باقی‌مانده تمام می‌شوند، و کار بیشتر جواب ارزان‌تری است تا جهش بزرگ‌تر وزنه.',
  'One less set for the first week back.':
    'برای هفته اول بازگشت، یک ست کمتر.',
  'Nothing in the plan trains {0}.':
    'هیچ چیزی در برنامه {0} را تمرین نمی‌دهد.',
  'Fewer days, not different exercises':
    'روزهای کمتر، نه حرکات متفاوت',
  'Only {0} of {1} planned sessions happened. Cutting the week down to what actually gets run beats redesigning sessions nobody reaches.':
    'فقط {0} جلسه از {1} جلسه برنامه‌ریزی‌شده انجام شد. کوتاه کردن هفته به آنچه واقعاً اجرا می‌شود بهتر از بازطراحی جلسه‌هایی است که کسی به آنها نمی‌رسد.',

  // Muscle names reached through muscleList() in the rationale above.
  'chest': 'سینه', 'upper back': 'بالای پشت', 'shoulders': 'سرشانه', 'biceps': 'جلو بازو',
  'triceps': 'پشت بازو', 'quads': 'چهارسر', 'hamstrings': 'همسترینگ', 'glutes': 'سرینی',
  'calves': 'ساق پا', 'abs': 'شکم', 'forearms': 'ساعد', 'traps': 'ذوزنقه', 'lats': 'زیربغل',
  'obliques': 'مورب شکمی', 'lower back': 'کمر', 'adductors': 'نزدیک‌کننده‌ها'
}

const PACKS = { fa: FA }

/**
 * A `t`-shaped translator for one language.
 *
 * Falls back to the English source string per key, so a sentence nobody has translated yet is
 * English inside an otherwise Persian note rather than a missing line.
 */
export function translatorFor(lang) {
  const pack = PACKS[lang]
  return (s, ...args) => {
    let v = (pack && pack[s]) || s
    for (let i = 0; i < args.length; i++) v = v.replaceAll('{' + i + '}', args[i])
    return v
  }
}

/** Which languages have a pack here — for tests and for an operator asking. */
export const NOTE_LANGS = Object.keys(PACKS)
