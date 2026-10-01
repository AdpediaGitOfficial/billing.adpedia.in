import { Decimal, ZERO, round2 } from '@/lib/money'

export interface Settlement {
  /** cash the client will actually send */
  amount: Decimal
  /** tax they withhold and pay to the government instead */
  tds: Decimal
}

/**
 * What settles an invoice in full.
 *
 * 🔴 A client pays NET of TDS, so the money that lands is short of the invoice by exactly
 * the tax they withheld. Someone recording the receipt by hand types the amount that
 * arrived, sees the invoice still showing a balance, and then either chases a payment the
 * client cannot legally make or writes the shortfall off as a bad debt. Neither is right:
 * the invoice IS settled, and the shortfall is a receivable from the government.
 *
 * This is the same reasoning the bank matcher applies to a credit that is short by exactly
 * the expected tax — stated once, here, so the manual path and the automatic one cannot
 * drift apart.
 */
export function settleInFull(outstanding: Decimal.Value, tdsExpected: Decimal.Value): Settlement {
  const total = round2(new Decimal(outstanding))
  const tds = round2(new Decimal(tdsExpected))

  if (total.lte(0)) return { amount: ZERO, tds: ZERO }

  // 🔴 TDS can never exceed what is outstanding. If a partial payment has already been
  // received, the remaining balance may be smaller than the tax originally expected on the
  // whole invoice — proposing the full tax would over-allocate and the service would refuse
  // it, with an error the person has no way to act on.
  const applicable = Decimal.min(Decimal.max(tds, ZERO), total)

  return { amount: total.minus(applicable), tds: applicable }
}
