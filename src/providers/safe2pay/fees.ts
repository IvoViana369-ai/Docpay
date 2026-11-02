import { percentOf, type BasisPoints, type Cents } from '../../money/cents.js';

/** Tarifa do contrato com o parceiro: valor fixo, percentual sobre o valor pago, ou os dois. */
export interface Fee {
  fixedCents: Cents;
  percentBps: BasisPoints;
}

/**
 * Lê a tarifa escrita como no contrato: "100" (R$ 1,00 por cobrança), "1,99%"
 * (ou "1.99%") ou "100+1,99%" (os dois). Lança Error se o texto não fizer
 * sentido.
 */
export function parseFee(text: string): Fee {
  // Com os dois, o "+" é obrigatório: sem ele, "101%" poderia virar 10 centavos mais 1%.
  const fixedOnly = /^\s*(\d+)\s*$/.exec(text);
  const withPercent = /^\s*(?:(\d+)\s*\+\s*)?(\d+(?:[.,]\d{1,2})?)\s*%\s*$/.exec(text);
  if (!fixedOnly && !withPercent) {
    throw new Error(
      `Tarifa inválida ("${text}"). Use centavos ("100" = R$ 1,00), percentual ("1,99%") ou os dois ("100+1,99%").`,
    );
  }
  const fixed = fixedOnly ? fixedOnly[1] : withPercent?.[1];
  const percent = withPercent?.[2];
  const fixedCents = fixed === undefined ? 0 : Number(fixed);
  const percentBps = percent === undefined ? 0 : toBasisPoints(percent);
  if (!Number.isSafeInteger(fixedCents) || percentBps > 10_000) {
    throw new Error(`Tarifa fora do limite ("${text}").`);
  }
  return { fixedCents, percentBps };
}

/** Tarifa de uma cobrança paga: o fixo mais o percentual, arredondado para baixo. */
export function feeFor(fee: Fee, amountCents: Cents): Cents {
  return fee.fixedCents + percentOf(amountCents, fee.percentBps);
}

function toBasisPoints(percent: string): BasisPoints {
  const [whole = '0', fraction = ''] = percent.replace(',', '.').split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}
