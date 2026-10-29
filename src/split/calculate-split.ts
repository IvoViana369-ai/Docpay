import { allocateProportionally } from '../money/allocate.js';
import { formatBRL, isCents, ONE_HUNDRED_PERCENT, type Cents } from '../money/cents.js';
import { SplitError, type SplitIssue } from './errors.js';
import type { FeePolicy, SplitInput, SplitResult, SplitShare } from './types.js';
import { validateSplitRule } from './validate-rule.js';

/**
 * Calcula quanto cada conta recebe de uma cobrança.
 *
 * 1. Cada destinatário recebe o valor fixo mais o percentual sobre o valor,
 *    arredondado para baixo.
 * 2. O beneficiário fica com o restante, inclusive os centavos de
 *    arredondamento.
 * 3. A tarifa do provedor sai de quem a regra mandar (padrão: o beneficiário).
 *
 * A soma das partes é exatamente o valor, a soma das tarifas é exatamente a
 * tarifa e nenhuma conta fica negativa. Se a regra ou os valores não
 * permitirem isso, lança SplitError com todos os problemas encontrados.
 */
export function calculateSplit(input: SplitInput): SplitResult {
  const { amountCents, feeCents = 0, rule } = input;

  const issues: SplitIssue[] = validateSplitRule(rule);
  if (!isCents(amountCents) || amountCents === 0) {
    issues.push({
      code: 'INVALID_AMOUNT',
      path: 'amountCents',
      message: `Valor inválido (${String(amountCents)}). Use centavos inteiros maiores que zero.`,
    });
  }
  if (!isCents(feeCents)) {
    issues.push({
      code: 'INVALID_FEE',
      path: 'feeCents',
      message: `Tarifa inválida (${String(feeCents)}). Use centavos inteiros e não negativos.`,
    });
  }
  if (issues.length > 0) throw new SplitError(issues);

  if (feeCents > amountCents) {
    throw new SplitError([
      {
        code: 'FEE_EXCEEDS_AMOUNT',
        path: 'feeCents',
        message: `A tarifa (${formatBRL(feeCents)}) é maior que o valor (${formatBRL(amountCents)}).`,
      },
    ]);
  }

  const amount = BigInt(amountCents);
  const recipients = rule.recipients.map(({ account, percentBps = 0, fixedCents = 0 }) => ({
    account,
    gross: BigInt(fixedCents) + (amount * BigInt(percentBps)) / BigInt(ONE_HUNDRED_PERCENT),
  }));
  const distributed = recipients.reduce((sum, recipient) => sum + recipient.gross, 0n);

  if (distributed > amount) {
    throw new SplitError([
      {
        code: 'SPLIT_EXCEEDS_AMOUNT',
        path: 'recipients',
        message: `Os repasses somam ${formatBRL(distributed)}, mais que o valor de ${formatBRL(amountCents)}.`,
      },
    ]);
  }

  const grossShares: GrossShare[] = [
    { account: rule.beneficiary, role: 'beneficiary', grossCents: Number(amount - distributed) },
    ...recipients.map(({ account, gross }) => ({
      account,
      role: 'recipient' as const,
      grossCents: Number(gross),
    })),
  ];
  const shares = chargeFee(grossShares, feeCents, rule.feePolicy);

  const shortShare = shares.find((share) => share.netCents < 0);
  if (shortShare) {
    throw new SplitError([
      {
        code: 'FEE_EXCEEDS_SHARE',
        path: 'feePolicy',
        message: `A conta ${shortShare.account} recebe ${formatBRL(shortShare.grossCents)}, menos que a tarifa de ${formatBRL(shortShare.feeCents)}.`,
      },
    ]);
  }

  return { amountCents, feeCents, shares };
}

type GrossShare = Pick<SplitShare, 'account' | 'role' | 'grossCents'>;

function chargeFee(
  shares: GrossShare[],
  feeCents: Cents,
  policy: FeePolicy | undefined,
): SplitShare[] {
  let fees: Cents[];
  if (policy?.kind === 'proportional') {
    fees = allocateProportionally(
      feeCents,
      shares.map((share) => share.grossCents),
    );
  } else {
    // Sem política, quem paga é o beneficiário, que é sempre a primeira parte.
    const payerIndex = policy ? shares.findIndex((share) => share.account === policy.payer) : 0;
    fees = shares.map((_, index) => (index === payerIndex ? feeCents : 0));
  }

  return shares.map((share, index) => {
    const fee = fees[index]!;
    return { ...share, feeCents: fee, netCents: share.grossCents - fee };
  });
}
