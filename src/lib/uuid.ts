/**
 * UUID utilities — branded Zod schema and factory function.
 *
 * @module
 */

import {z} from 'zod';

export const create_uuid = (): Uuid => crypto.randomUUID() as Uuid;

export const Uuid = z.uuid().brand('Uuid');
export type Uuid = z.infer<typeof Uuid>;
export const UuidWithDefault = Uuid.default(create_uuid);
export type UuidWithDefault = z.infer<typeof UuidWithDefault>;
