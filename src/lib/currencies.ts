/**
 * ISO 4217, for the currencies a service exporter from India realistically bills in.
 *
 * 🔴 `words` is not decoration. The invoice and the credit note print the total in words
 * under rule 46, and both read `cur === 'INR' ? 'Indian Rupees' : 'US Dollars'` — so an
 * invoice billed in dirhams or pounds said **US Dollars** on the face of the document,
 * for a figure that was neither. Anything that stores a currency must be able to say it.
 *
 * Unlisted codes are allowed through and fall back to the bare code, because refusing a
 * currency outright is worse than printing "ZMW" where a name would read better.
 */
export interface Currency {
  code: string
  /** For a dropdown: "USD — US Dollar". */
  name: string
  /** For the amount in words, always plural: "… Ninety Only". */
  words: string
}

export const CURRENCIES: readonly Currency[] = [
  { code: 'INR', name: 'Indian Rupee', words: 'Indian Rupees' },
  { code: 'USD', name: 'US Dollar', words: 'US Dollars' },
  { code: 'EUR', name: 'Euro', words: 'Euros' },
  { code: 'GBP', name: 'Pound Sterling', words: 'Pounds Sterling' },
  { code: 'AED', name: 'UAE Dirham', words: 'UAE Dirhams' },
  { code: 'SGD', name: 'Singapore Dollar', words: 'Singapore Dollars' },
  { code: 'AUD', name: 'Australian Dollar', words: 'Australian Dollars' },
  { code: 'NZD', name: 'New Zealand Dollar', words: 'New Zealand Dollars' },
  { code: 'CAD', name: 'Canadian Dollar', words: 'Canadian Dollars' },
  { code: 'CHF', name: 'Swiss Franc', words: 'Swiss Francs' },
  { code: 'CNY', name: 'Chinese Yuan Renminbi', words: 'Chinese Yuan' },
  { code: 'HKD', name: 'Hong Kong Dollar', words: 'Hong Kong Dollars' },
  { code: 'JPY', name: 'Japanese Yen', words: 'Japanese Yen' },
  { code: 'KRW', name: 'South Korean Won', words: 'South Korean Won' },
  { code: 'MYR', name: 'Malaysian Ringgit', words: 'Malaysian Ringgit' },
  { code: 'THB', name: 'Thai Baht', words: 'Thai Baht' },
  { code: 'IDR', name: 'Indonesian Rupiah', words: 'Indonesian Rupiah' },
  { code: 'PHP', name: 'Philippine Peso', words: 'Philippine Pesos' },
  { code: 'VND', name: 'Vietnamese Dong', words: 'Vietnamese Dong' },
  { code: 'TWD', name: 'New Taiwan Dollar', words: 'New Taiwan Dollars' },
  { code: 'LKR', name: 'Sri Lankan Rupee', words: 'Sri Lankan Rupees' },
  { code: 'NPR', name: 'Nepalese Rupee', words: 'Nepalese Rupees' },
  { code: 'BDT', name: 'Bangladeshi Taka', words: 'Bangladeshi Taka' },
  { code: 'PKR', name: 'Pakistani Rupee', words: 'Pakistani Rupees' },
  { code: 'SAR', name: 'Saudi Riyal', words: 'Saudi Riyals' },
  { code: 'QAR', name: 'Qatari Riyal', words: 'Qatari Riyals' },
  { code: 'KWD', name: 'Kuwaiti Dinar', words: 'Kuwaiti Dinars' },
  { code: 'BHD', name: 'Bahraini Dinar', words: 'Bahraini Dinars' },
  { code: 'OMR', name: 'Omani Rial', words: 'Omani Rials' },
  { code: 'ZAR', name: 'South African Rand', words: 'South African Rand' },
  { code: 'KES', name: 'Kenyan Shilling', words: 'Kenyan Shillings' },
  { code: 'NGN', name: 'Nigerian Naira', words: 'Nigerian Naira' },
  { code: 'EGP', name: 'Egyptian Pound', words: 'Egyptian Pounds' },
  { code: 'TRY', name: 'Turkish Lira', words: 'Turkish Lira' },
  { code: 'RUB', name: 'Russian Ruble', words: 'Russian Rubles' },
  { code: 'BRL', name: 'Brazilian Real', words: 'Brazilian Reais' },
  { code: 'MXN', name: 'Mexican Peso', words: 'Mexican Pesos' },
  { code: 'SEK', name: 'Swedish Krona', words: 'Swedish Kronor' },
  { code: 'NOK', name: 'Norwegian Krone', words: 'Norwegian Kroner' },
  { code: 'DKK', name: 'Danish Krone', words: 'Danish Kroner' },
  { code: 'PLN', name: 'Polish Zloty', words: 'Polish Zloty' },
  { code: 'ILS', name: 'Israeli New Shekel', words: 'Israeli New Shekels' },
  { code: 'MUR', name: 'Mauritian Rupee', words: 'Mauritian Rupees' },
]

const BY_CODE = new Map(CURRENCIES.map((c) => [c.code, c]))

/** "US Dollar", or the bare code for anything not listed. */
export function currencyName(code: string | null | undefined): string {
  if (!code) return ''
  return BY_CODE.get(code.toUpperCase())?.name ?? code
}

/** The plural used in the amount-in-words line. */
export function currencyWords(code: string | null | undefined): string {
  if (!code) return ''
  return BY_CODE.get(code.toUpperCase())?.words ?? code
}

export function isKnownCurrency(code: string | null | undefined): boolean {
  return !!code && BY_CODE.has(code.toUpperCase())
}
