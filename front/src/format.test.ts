import { expect, it } from 'vitest'
import { formatearCents } from './format'

// Intl usa un espacio no separable antes del símbolo
const normal = (s: string) => s.replace(/ /g, ' ')

it('formatea céntimos como euros', () => {
  expect(normal(formatearCents(1000))).toBe('10,00 €')
  expect(normal(formatearCents(1))).toBe('0,01 €')
  expect(normal(formatearCents(123456))).toBe('1234,56 €')
})
