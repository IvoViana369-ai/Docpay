import type { PayerAddress } from '../providers/types.js';
import { isFilled } from '../shared/text.js';

export interface MissingAddressField {
  field: keyof PayerAddress;
  /** Nome do campo para mostrar: "CEP", "logradouro"... */
  label: string;
}

/**
 * O que falta no endereço do pagador para emitir um boleto, na ordem do
 * cadastro. Lista vazia: endereço completo. O número é opcional ("S/N").
 */
export function missingAddressFields(address: Partial<PayerAddress> | undefined): MissingAddressField[] {
  const value = address ?? {};
  const missing: MissingAddressField[] = [];
  if (onlyDigits(value.zipCode).length !== 8) missing.push({ field: 'zipCode', label: 'CEP' });
  if (!isFilled(value.street)) missing.push({ field: 'street', label: 'logradouro' });
  if (!isFilled(value.district)) missing.push({ field: 'district', label: 'bairro' });
  if (!isFilled(value.city)) missing.push({ field: 'city', label: 'cidade' });
  if (!/^[A-Za-z]{2}$/.test(String(value.state ?? '').trim())) missing.push({ field: 'state', label: 'UF' });
  return missing;
}

export function onlyDigits(value: unknown): string {
  return String(value ?? '').replace(/\D/g, '');
}
