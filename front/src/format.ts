const euros = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' })

// Las APIs trabajan en céntimos; solo se convierte a euros al pintar.
export const formatearCents = (cents: number): string => euros.format(cents / 100)
