/**
 * Type pins for the structural Zod types of `schema_issues.ts`
 * (`ZodSchemaLike`, `ZodObjectLike`, `ZodVoidLike`, `ZodIssueLike`,
 * `ZodErrorLike`): the public signatures that name a Zod schema through them
 * infer from a Zod schema exactly what `z.output` / `z.input` give, and from a
 * `@fuzdev/fuz_schema` schema what `Infer` gives. The pins are checked by
 * `gro typecheck`; the functions holding inferring calls are never run.
 *
 * @module
 */

import { describe, test, expectTypeOf } from 'vitest';
import { z } from 'zod';
import * as zm from 'zod/mini';
import { object, pipe, string, transform } from '@fuzdev/fuz_schema/schema.ts';

import {
	parse_any,
	type AnyIssue,
	type ValidationInput,
	type ValidationOutput,
	type ValidationSchema,
	type ZodErrorLike,
	type ZodObjectLike,
	type ZodSchemaLike,
	type ZodVoidLike
} from '#lib/schema_issues.ts';
import { expect_output, type RpcResult } from '#lib/testing/cross_backend/cross_rpc.ts';
import { rpc_call_typed, type RpcCallArgs } from '#lib/testing/rpc_helpers.ts';
import type {
	RemoteNotificationActionSpec,
	RequestResponseActionSpec
} from '#lib/actions/action_spec.ts';
import type { HandlerForSpec } from '#lib/actions/action_types.ts';
import { ZodUuid } from '#lib/zod_schemas.ts';
import type { Uuid } from '#lib/primitive_schemas.ts';

const zod_object = z.object({ a: z.string() });
const zod_strict = z.strictObject({ name: z.string(), n: z.number().default(1) });
const zod_transform = z.string().transform((s) => s.length);
const zod_union = z.union([z.literal('x'), z.strictObject({ y: z.number().optional() })]);
const _zod_branded = z.string().brand<'Thing'>();
const fuz_object = object({ a: string });
const fuz_transform = pipe(
	string,
	transform((s: string) => s.length)
);

describe('ValidationOutput / ValidationInput match z.output / z.input', () => {
	test('for every shape of Zod schema', () => {
		expectTypeOf<ValidationOutput<typeof zod_object>>().toEqualTypeOf<
			z.output<typeof zod_object>
		>();
		expectTypeOf<ValidationOutput<typeof zod_strict>>().toEqualTypeOf<
			z.output<typeof zod_strict>
		>();
		expectTypeOf<ValidationInput<typeof zod_strict>>().toEqualTypeOf<z.input<typeof zod_strict>>();
		expectTypeOf<ValidationOutput<typeof zod_transform>>().toEqualTypeOf<number>();
		expectTypeOf<ValidationInput<typeof zod_transform>>().toEqualTypeOf<string>();
		expectTypeOf<ValidationOutput<typeof zod_union>>().toEqualTypeOf<z.output<typeof zod_union>>();
		expectTypeOf<ValidationOutput<typeof _zod_branded>>().toEqualTypeOf<
			z.output<typeof _zod_branded>
		>();
		expectTypeOf<ValidationOutput<typeof ZodUuid>>().toEqualTypeOf<Uuid>();
		expectTypeOf<ValidationOutput<ZodSchemaLike<{ a: string }>>>().toEqualTypeOf<{ a: string }>();
	});

	test('and a fuz_schema schema keeps its Infer', () => {
		expectTypeOf<ValidationOutput<typeof fuz_object>>().toEqualTypeOf<{ a: string }>();
		expectTypeOf<ValidationOutput<typeof fuz_transform>>().toEqualTypeOf<number>();
		expectTypeOf<ValidationInput<typeof fuz_transform>>().toEqualTypeOf<string>();
	});
});

describe('signatures infer T from a schema of either library', () => {
	test('expect_output', () => {
		const _check = (r: RpcResult) => {
			expectTypeOf(expect_output(r, zod_object)).toEqualTypeOf<{ a: string }>();
			expectTypeOf(expect_output(r, zod_strict)).toEqualTypeOf<{ name: string; n: number }>();
			expectTypeOf(expect_output(r, zod_transform)).toEqualTypeOf<number>();
			expectTypeOf(expect_output(r, ZodUuid)).toEqualTypeOf<Uuid>();
			expectTypeOf(expect_output(r, fuz_object)).toEqualTypeOf<{ a: string }>();
			expectTypeOf(expect_output(r, fuz_transform)).toEqualTypeOf<number>();
		};
		expectTypeOf(_check).toBeFunction();
	});

	test('rpc_call_typed', () => {
		const _check = (args: RpcCallArgs) => {
			expectTypeOf(rpc_call_typed(args, zod_object)).toEqualTypeOf<Promise<{ a: string }>>();
			expectTypeOf(rpc_call_typed(args, fuz_object)).toEqualTypeOf<Promise<{ a: string }>>();
		};
		expectTypeOf(_check).toBeFunction();
	});

	test('parse_any', () => {
		const _check = () => {
			const zod_result = parse_any(zod_strict, {});
			if (zod_result.ok)
				expectTypeOf(zod_result.value).toEqualTypeOf<{ name: string; n: number }>();
			else expectTypeOf(zod_result.issues).toEqualTypeOf<Array<AnyIssue>>();
			const fuz_result = parse_any(fuz_object, {});
			if (fuz_result.ok) expectTypeOf(fuz_result.value).toEqualTypeOf<{ a: string }>();
		};
		expectTypeOf(_check).toBeFunction();
	});

	test('an action spec with Zod input and output', () => {
		const _spec = {
			method: 'thing_get',
			kind: 'request_response',
			initiator: 'frontend',
			auth: { account: 'none', actor: 'none' },
			side_effects: false,
			input: zod_strict,
			output: zod_object,
			async: true,
			description: 'gets a thing'
		} satisfies RequestResponseActionSpec;
		type Handler = HandlerForSpec<typeof _spec>;
		expectTypeOf<Parameters<Handler>[0]>().toEqualTypeOf<{ name: string; n: number }>();
		expectTypeOf<ReturnType<Handler>>().toEqualTypeOf<{ a: string } | Promise<{ a: string }>>();
	});
});

describe('the structural types admit what the Zod types admitted', () => {
	test('ValidationSchema takes a Zod schema of any shape', () => {
		expectTypeOf(zod_object).toExtend<ValidationSchema>();
		expectTypeOf(zod_transform).toExtend<ValidationSchema>();
		expectTypeOf(zod_union).toExtend<ValidationSchema>();
		expectTypeOf(ZodUuid).toExtend<ValidationSchema>();
		expectTypeOf(fuz_object).toExtend<ValidationSchema>();
	});

	test('ZodObjectLike takes a Zod object and no other Zod schema', () => {
		expectTypeOf(zod_object).toExtend<ZodObjectLike>();
		expectTypeOf(zod_strict).toExtend<ZodObjectLike>();
		expectTypeOf(z.looseObject({})).toExtend<ZodObjectLike>();
		expectTypeOf(z.string()).not.toExtend<ZodObjectLike>();
		expectTypeOf(fuz_object).not.toExtend<ZodObjectLike>();
	});

	test('ZodVoidLike takes z.void() and not z.undefined()', () => {
		expectTypeOf(z.void()).toExtend<ZodVoidLike>();
		expectTypeOf(z.undefined()).not.toExtend<ZodVoidLike>();
		expectTypeOf<RemoteNotificationActionSpec['output']>().toExtend<ValidationSchema>();
	});

	test('a Zod issue is an AnyIssue and a ZodError a ZodErrorLike', () => {
		expectTypeOf<z.core.$ZodIssue>().toExtend<AnyIssue>();
		expectTypeOf<z.ZodError>().toExtend<ZodErrorLike>();
	});
});

describe('ZodSchemaLike is the classic API only', () => {
	test('a zod/mini schema is not a ValidationSchema', () => {
		const mini = zm.object({ a: zm.string() });
		expectTypeOf(mini).not.toExtend<ValidationSchema>();
		expectTypeOf(mini).not.toExtend<ZodSchemaLike>();
		expectTypeOf(zm.string()).not.toExtend<ValidationSchema>();
		// @ts-expect-error a zod/mini schema is refused where a schema is taken
		const _refused: ValidationSchema = mini;
	});

	test('a classic schema of every kind is', () => {
		expectTypeOf(z.lazy(() => z.string())).toExtend<ValidationSchema>();
		expectTypeOf(z.custom<number>()).toExtend<ValidationSchema>();
		expectTypeOf(_zod_branded).toExtend<ValidationSchema>();
		expectTypeOf(z.string().pipe(z.coerce.number())).toExtend<ValidationSchema>();
		expectTypeOf(z.void()).toExtend<ValidationSchema>();
	});

	test('a fake _zod object is not one', () => {
		expectTypeOf<{ _zod: ZodSchemaLike['_zod'] }>().not.toExtend<ValidationSchema>();
	});
});
