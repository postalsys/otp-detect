// Words that tell a one-time code apart from every other number in an email. The lists are hand
// written and multilingual; the model learns how much each class matters from how close it is to
// a candidate. Adding a language means adding phrases here, not retraining on its mail.

function compile(phrases: string[]): RegExp {
    return new RegExp(phrases.map(p => `(?:${p})`).join('|'), 'giu');
}

/** Phrases that name a one-time code */
export const STRONG = compile([
    // English
    'verification code',
    'verify code',
    'validation code',
    'security code',
    'confirmation code',
    'one[- ]time (?:pass(?:code|word)|code|pin|password|key)',
    '\\botp\\b',
    'pass ?code',
    'log ?in code',
    'sign[- ]?in code',
    'access code',
    'authentication code',
    'auth code',
    '\\b2fa\\b',
    'two[- ]factor',
    '2-step',
    'two[- ]step',
    'temporary (?:code|password|pin)',
    'single[- ]use code',
    'guard code',
    'magic code',
    'activation code',
    'reset code',
    'recovery code',
    'device code',
    'approval code',
    'your code(?: is)?',
    'code to (?:sign|log|verify|confirm|continue|complete)',
    'enter (?:this|the following|the) code',
    // Estonian
    'kinnituskood',
    'turvakood',
    'ühekordne (?:kood|parool|salasõna)',
    'sisselogimiskood',
    'kontrollkood',
    'autentimiskood',
    'verifitseerimiskood',
    'aktiveerimiskood',
    'sinu kood',
    'teie kood',
    // German
    'bestätigungscode',
    'sicherheitscode',
    'einmal-?(?:code|passwort|kennwort)',
    'verifizierungscode',
    'anmeldecode',
    'ihr code',
    'zugangscode',
    'prüfcode',
    // French, Spanish, Portuguese, Italian
    'code de (?:vérification|confirmation|sécurité|connexion|validation)',
    'code à usage unique',
    'votre code',
    'código de (?:verificación|verificação|seguridad|segurança|confirmación|confirmação|acceso|acesso)',
    'tu código',
    'seu código',
    'codice (?:di verifica|di sicurezza|di accesso|di conferma|otp)',
    // Dutch, Nordic, Finnish
    'verificatiecode',
    'beveiligingscode',
    'inlogcode',
    'bevestigingscode',
    'verifieringskod',
    'engångskod',
    'säkerhetskod',
    'bekræftelseskode',
    'sikkerhedskode',
    'engangskode',
    'bekreftelseskode',
    'vahvistuskoodi',
    'turvakoodi',
    'kertakäyttöinen',
    // Baltic, Polish, Czech
    'verifikācijas kods',
    'apstiprinājuma kods',
    'drošības kods',
    'patvirtinimo kodas',
    'saugos kodas',
    'kod weryfikacyjny',
    'kod potwierdzający',
    'kod jednorazowy',
    'ověřovací kód',
    'bezpečnostní kód',
    // Russian, Ukrainian
    'код подтверждения',
    'проверочный код',
    'код для входа',
    'одноразов\\p{L}* (?:код|пароль)',
    'код безопасности',
    'ваш код',
    'код підтвердження',
    // CJK, Turkish
    '验证码',
    '驗證碼',
    '認証コード',
    '確認コード',
    'ワンタイム',
    '인증번호',
    '인증 코드',
    'doğrulama kodu',
    'güvenlik kodu'
]);

/** Generic words for a code or secret, weaker evidence on their own */
export const WEAK = compile([
    '\\bcodes?\\b',
    '\\bkood\\b',
    '\\bpin\\b',
    '\\bpassword\\b',
    '\\bparool\\b',
    '\\bsalasõna\\b',
    '\\btoken\\b',
    '\\bkods\\b',
    '\\bkodas\\b',
    '\\bkode\\b',
    '\\bkod\\b',
    '\\bkoodi\\b',
    '\\bcodice\\b',
    '\\bcódigo\\b',
    // \b only knows ASCII word characters
    '(?<!\\p{L})код(?!\\p{L})',
    'コード',
    '码',
    '碼',
    'kontrollsõna'
]);

/** How a one-time code is introduced or limited: instructions, expiry, warnings */
export const CUE = compile([
    '\\benter\\b',
    '\\btype\\b',
    '\\bpaste\\b',
    'expires?',
    'valid (?:for|until)',
    '\\bminutes?\\b',
    '\\bmins?\\b',
    "(?:do not|don't|never) share",
    "(?:did not|didn't) (?:request|try|attempt)",
    'ignore this (?:e-?mail|message)',
    'sisesta',
    'kehtib',
    'kehtiv',
    'minuti',
    'ära jaga',
    'eingeben',
    'gültig',
    'minuten',
    'nicht weiter',
    'ingres[ae]',
    'introduce',
    'válido',
    'minutos',
    'saisissez',
    'valable',
    'введите',
    'действител',
    'минут',
    '分钟',
    '有效'
]);

/** Words that introduce the other kinds of numbers an email is full of */
export const NEGATIVE = compile([
    '\\border\\b',
    'invoice',
    'receipt',
    'tracking',
    'shipment',
    'parcel',
    'package',
    '\\bphone\\b',
    '\\btel\\b',
    '\\bfax\\b',
    '\\bmobile\\b',
    '\\bref(?:erence)?\\b',
    'customer',
    'account (?:no|number)',
    'booking',
    'reservation',
    'ticket',
    'promo',
    'discount',
    'coupon',
    'voucher',
    'gift',
    '\\bzip\\b',
    'postal',
    'price',
    '\\btotal\\b',
    'amount',
    '\\biban\\b',
    '\\bvat\\b',
    'license',
    'serial',
    '\\bid\\b',
    'member',
    'transaction',
    'tellimus',
    '\\barve\\b',
    'viitenumber',
    'telefon',
    'pakk',
    'pakiautomaat',
    'kupong',
    'sooduskood',
    '\\bsumma\\b',
    'kokku',
    '\\bhind\\b',
    'registrikood',
    'isikukood',
    'bestellung',
    'rechnung',
    'sendungsnummer',
    'kundennummer',
    'gutschein',
    'pedido',
    'factura',
    'commande',
    'facture',
    'заказ',
    'счет'
]);

/** Codes that are handed out but prove nothing: promotions, referrals, invitations, gifts */
export const PROMO = compile([
    'promo',
    'discount',
    'coupon',
    'voucher',
    'referral',
    '\\brefer\\b',
    'invite',
    'invitation',
    '\\bgift\\b',
    'redeem',
    '\\boffer\\b',
    '\\bsale\\b',
    '\\d+ ?% off',
    '\\bfree\\b',
    '\\bsave\\b',
    'share (?:your|this) code',
    'friends?',
    '\\bvip\\b',
    'checkout',
    'sooduskood',
    'soodus',
    'allahindlus',
    'kinkekaart',
    'kupong',
    'tasuta',
    'gutschein',
    'rabatt',
    'empfehl',
    'descuento',
    'cupón',
    'réduction',
    'parrainage',
    'скидк',
    'промокод',
    '优惠'
]);

/** Start and end offsets of every match, sorted by start */
export function findAll(re: RegExp, text: string): { start: number; end: number }[] {
    const out: { start: number; end: number }[] = [];
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
        out.push({ start: m.index, end: m.index + m[0].length });
        if (m[0].length === 0) {
            re.lastIndex++;
        }
    }
    return out;
}

export function matches(re: RegExp, text: string): boolean {
    re.lastIndex = 0;
    return re.test(text);
}
