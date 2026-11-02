/*
 * Formato dos pedidos que chegam pela API. Aqui só se confere o formato
 * (campos e tipos); os valores são conferidos pelo DocPay, que devolve cada
 * problema com o campo e uma explicação.
 */

const text = (maxLength: number) => ({ type: 'string', maxLength }) as const;
const integer = { type: 'integer' } as const;

const address = {
  type: 'object',
  additionalProperties: false,
  properties: {
    zipCode: text(20),
    street: text(150),
    number: text(15),
    complement: text(150),
    district: text(60),
    city: text(200),
    state: text(30),
  },
} as const;

const payer = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'document'],
  properties: {
    name: text(200),
    document: text(30),
    email: text(150),
    phone: text(30),
    address,
  },
} as const;

const recipient = {
  type: 'object',
  additionalProperties: false,
  required: ['account'],
  properties: { account: text(100), percentBps: integer, fixedCents: integer },
} as const;

const feePolicy = {
  type: 'object',
  additionalProperties: false,
  required: ['kind'],
  properties: { kind: text(20), payer: text(100) },
} as const;

const rule = {
  type: 'object',
  additionalProperties: false,
  required: ['beneficiary', 'recipients'],
  properties: {
    beneficiary: text(100),
    recipients: { type: 'array', maxItems: 20, items: recipient },
    feePolicy,
  },
} as const;

export const createChargeBody = {
  type: 'object',
  additionalProperties: false,
  required: ['idempotencyKey', 'method', 'amountCents', 'dueDate', 'payer', 'rule'],
  properties: {
    idempotencyKey: text(200),
    reference: text(100),
    method: text(20),
    amountCents: integer,
    dueDate: text(20),
    payer,
    rule,
    description: text(500),
    fiscalDocumentKey: text(100),
  },
} as const;

export const accountBody = {
  type: 'object',
  additionalProperties: false,
  required: ['name'],
  properties: {
    name: text(200),
    providerRefs: { type: 'object', additionalProperties: text(100) },
  },
} as const;

export const simulatedPaymentBody = {
  type: 'object',
  additionalProperties: false,
  properties: { method: { type: 'string', enum: ['boleto', 'pix'] }, paidAmountCents: integer },
} as const;
