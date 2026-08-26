/* The one email this app sends, in the languages it speaks.
 *
 * ## Why these are here and not in the locale packs
 *
 * Every other string in GymBuddy is translated in the client, because every other string is
 * rendered there. This one is written by the server for somebody who is not signed in, on a
 * device that may not be the one they use the app on. There is nobody to ask.
 *
 * That is only possible because `users.locale` is real now — it shipped as a column nothing
 * ever wrote, which would have made this English for everybody regardless of what is below.
 * The language used is the account's own setting, not the browser that asked: the person
 * reading this is the account holder, and what they set on their profile is the better answer
 * than whatever locale the machine requesting the reset happens to have.
 *
 * ## Why an hour is not configurable
 *
 * The text says an hour, in thirteen languages. A knob that changes the expiry without changing
 * the sentence is a knob that makes the email lie, and translating "{0} hours" correctly across
 * languages with four plural forms to save an operator a setting nobody has asked for is not a
 * trade worth making. One hour, stated, everywhere.
 */

/** How long a reset link lives. Stated in the text below — see the header before changing it. */
export const RESET_TTL_MINUTES = 60

const T = {
  en: {
    subject: 'Reset your GymBuddy password',
    body: (name, url) => `Hi ${name},

Someone asked to reset the password on your GymBuddy account. If that was you, open this link:

${url}

The link works once, and stops working after an hour.

If it wasn't you, ignore this email — nothing has changed and your current password still works.`
  },

  de: {
    subject: 'GymBuddy-Passwort zurücksetzen',
    body: (name, url) => `Hallo ${name},

jemand hat angefragt, das Passwort deines GymBuddy-Kontos zurückzusetzen. Warst du das, dann öffne diesen Link:

${url}

Der Link funktioniert einmal und läuft nach einer Stunde ab.

Warst du das nicht, ignoriere diese E-Mail einfach — es hat sich nichts geändert und dein Passwort gilt weiter.`
  },

  es: {
    subject: 'Restablece tu contraseña de GymBuddy',
    body: (name, url) => `Hola ${name}:

Alguien ha pedido restablecer la contraseña de tu cuenta de GymBuddy. Si has sido tú, abre este enlace:

${url}

El enlace funciona una vez y caduca al cabo de una hora.

Si no has sido tú, puedes ignorar este correo: no ha cambiado nada y tu contraseña sigue siendo válida.`
  },

  fr: {
    subject: 'Réinitialiser votre mot de passe GymBuddy',
    body: (name, url) => `Bonjour ${name},

Quelqu'un a demandé la réinitialisation du mot de passe de votre compte GymBuddy. Si c'était vous, ouvrez ce lien :

${url}

Le lien fonctionne une seule fois et expire au bout d'une heure.

Si ce n'était pas vous, ignorez cet e-mail — rien n'a changé et votre mot de passe reste valable.`
  },

  it: {
    subject: 'Reimposta la tua password GymBuddy',
    body: (name, url) => `Ciao ${name},

qualcuno ha chiesto di reimpostare la password del tuo account GymBuddy. Se sei stato tu, apri questo link:

${url}

Il link funziona una volta sola e scade dopo un'ora.

Se non sei stato tu, puoi ignorare questa email: non è cambiato nulla e la tua password è ancora valida.`
  },

  pt: {
    subject: 'Repor a sua palavra-passe do GymBuddy',
    body: (name, url) => `Olá ${name},

Alguém pediu para repor a palavra-passe da sua conta GymBuddy. Se foi você, abra esta ligação:

${url}

A ligação funciona uma vez e expira ao fim de uma hora.

Se não foi você, ignore este e-mail — nada mudou e a sua palavra-passe continua válida.`
  },

  pl: {
    subject: 'Zresetuj hasło do GymBuddy',
    body: (name, url) => `Cześć ${name},

ktoś poprosił o zresetowanie hasła do Twojego konta GymBuddy. Jeśli to Ty, otwórz ten link:

${url}

Link zadziała raz i wygaśnie po godzinie.

Jeśli to nie Ty, zignoruj tę wiadomość — nic się nie zmieniło, a Twoje hasło nadal działa.`
  },

  tr: {
    subject: 'GymBuddy şifreni sıfırla',
    body: (name, url) => `Merhaba ${name},

Birisi GymBuddy hesabının şifresini sıfırlamak istedi. Bu sensen şu bağlantıyı aç:

${url}

Bağlantı bir kez çalışır ve bir saat sonra geçersiz olur.

Sen değilsen bu e-postayı yok sayabilirsin — hiçbir şey değişmedi ve mevcut şifren çalışmaya devam ediyor.`
  },

  ru: {
    subject: 'Сброс пароля GymBuddy',
    body: (name, url) => `Здравствуйте, ${name}!

Кто-то запросил сброс пароля для вашей учётной записи GymBuddy. Если это были вы, откройте эту ссылку:

${url}

Ссылка сработает один раз и перестанет действовать через час.

Если это были не вы, просто проигнорируйте письмо — ничего не изменилось, и ваш пароль по-прежнему работает.`
  },

  zh: {
    subject: '重置你的 GymBuddy 密码',
    body: (name, url) => `你好 ${name}，

有人请求重置你的 GymBuddy 账户密码。如果是你本人，请打开这个链接：

${url}

该链接只能使用一次，一小时后失效。

如果不是你，忽略这封邮件即可 —— 什么都没有改变，你的密码仍然有效。`
  },

  ko: {
    subject: 'GymBuddy 비밀번호 재설정',
    body: (name, url) => `${name}님, 안녕하세요.

누군가 GymBuddy 계정의 비밀번호 재설정을 요청했습니다. 본인이라면 아래 링크를 열어 주세요.

${url}

링크는 한 번만 사용할 수 있고 한 시간 뒤에 만료됩니다.

본인이 아니라면 이 메일은 무시하셔도 됩니다. 아무것도 변경되지 않았고 기존 비밀번호는 그대로 사용할 수 있습니다.`
  },

  hi: {
    subject: 'अपना GymBuddy पासवर्ड रीसेट करें',
    body: (name, url) => `नमस्ते ${name},

किसी ने आपके GymBuddy खाते का पासवर्ड रीसेट करने के लिए कहा है। अगर यह आप थे, तो यह लिंक खोलें:

${url}

यह लिंक एक बार काम करता है और एक घंटे बाद बंद हो जाता है।

अगर यह आप नहीं थे, तो इस ईमेल को अनदेखा कर दें — कुछ नहीं बदला है और आपका पासवर्ड अब भी काम करता है।`
  },

  fa: {
    subject: 'بازنشانی رمز عبور جیم‌بادی',
    body: (name, url) => `سلام ${name}،

کسی درخواست بازنشانی رمز عبور حساب جیم‌بادی شما را داده است. اگر خودتان بوده‌اید، این پیوند را باز کنید:

${url}

این پیوند یک‌بار کار می‌کند و پس از یک ساعت از کار می‌افتد.

اگر شما نبوده‌اید، این ایمیل را نادیده بگیرید — چیزی تغییر نکرده و رمز عبور فعلی‌تان همچنان کار می‌کند.`
  }
}

export const MAIL_LOCALES = Object.keys(T)

/**
 * The reset email, in this account's language.
 *
 * English for a language with no translation here rather than a throw: an email that goes out
 * in the wrong language is a bad day, and one that does not go out at all is a lost account.
 */
export function resetEmail({ name, url, locale = 'en' }) {
  const pack = T[locale] || T.en
  return { subject: pack.subject, text: pack.body(name || 'there', url) }
}
