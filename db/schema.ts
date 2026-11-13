import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
export const settings = sqliteTable('settings', {
  id: text('id').primaryKey(),
  value: text('value').notNull(),
});
export const printers = sqliteTable('printers', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  brand: text('brand').notNull(),
  model: text('model').notNull(),
  capability: text('capability').notNull(),
  connection: text('connection').notNull(),
});
export const agents = sqliteTable('agents', {
  id: text('id').primaryKey(),
  seen: integer('seen').notNull(),
  inventory: text('inventory').notNull(),
  mode: text('mode').notNull(),
});
export const orders = sqliteTable('orders', {
  id: text('id').primaryKey(),
  token: text('token').notNull().unique(),
  created: integer('created').notNull(),
  updated: integer('updated').notNull(),
  names: text('names').notNull(),
  options: text('options').notNull(),
  pages: integer('pages').notNull(),
  amount: integer('amount').notNull(),
  method: text('method').notNull(),
  payment: text('payment').notNull(),
  status: text('status').notNull(),
  file: text('file').notNull(),
  printer: text('printer'),
  claim: text('claim'),
  error: text('error'),
  gateway: text('gateway').unique(),
  paymentId: text('payment_id').unique(),
});
export const events = sqliteTable('events', {
  id: text('id').primaryKey(),
  orderId: text('order_id').notNull(),
  created: integer('created').notNull(),
  action: text('action').notNull(),
});
