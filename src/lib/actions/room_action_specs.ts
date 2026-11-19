/**
 * The room verbs' wire: the `room_*` request specs, the `room_*`
 * notifications the registry fans out, their schemas, refusal reasons, and
 * bounds — the TS twin of the Rust spine's `fuz_actions::room` specs and
 * `fuz_realtime::room_registry` notification shapes.
 *
 * A room is a key (`RoomId`) the consumer chooses and parses, holding seats
 * (members, each with a random `MemberId` and a small client-encoded state)
 * and watches (occupancy without a seat). `actions/room_registry.ts` holds
 * the state and the fan-out; `actions/room_actions.ts` builds the handlers
 * over it. Every verb is WebSocket-only — a room belongs to a socket — so a
 * consumer mounts them on a WS endpoint and never on an RPC one, actor-required
 * (`acting` selects the actor on a multi-actor account), and without side
 * effects (the registry is memory, so no transaction opens).
 *
 * `payload` and `state` are strings the client encodes, so both twins measure
 * their bounds alike, in UTF-8 bytes, and charge the per-connection limiter
 * their JSON-escaped length (`json_escaped_len`). Refusals carry `data.reason`,
 * the `ERROR_ROOM_*` constants, plus `rate_limited` with `data.retry_after`.
 * Every member event carries the room's `seq` (`actions/room_registry.ts`
 * says what it promises).
 *
 * @module
 */

import { meta } from '@fuzdev/fuz_schema/meta.ts';
import {
	array,
	boolean,
	literal,
	max_length,
	min_length,
	min_value,
	nullable,
	number,
	object,
	one_of,
	optional,
	pipe,
	regex,
	safe_integer,
	string,
	unknown,
	void as fuz_void,
	type Infer
} from '@fuzdev/fuz_schema/schema.ts';

import { ActingActor, Uuid } from '../primitive_schemas.ts';
import type {
	ActionSpecUnion,
	RemoteNotificationActionSpec,
	RequestResponseActionSpec
} from './action_spec.ts';
import type { Action } from './action_types.ts';

// -- Bounds -------------------------------------------------------------------

/**
 * The longest `RoomId`, in characters — and bytes, since a room id is ASCII.
 * Twin of the Rust `ROOM_ID_MAX_LENGTH`.
 */
export const ROOM_ID_MAX_LENGTH = 128;

/**
 * Default `RoomRegistryOptions.max_members_per_room`: generous for a
 * full-mesh call, where every member holds a peer connection to every other.
 */
export const DEFAULT_ROOM_MAX_MEMBERS = 32;

/**
 * Default `RoomRegistryOptions.max_payload_bytes`: room for a session
 * description with many candidates, small beside the outbound budget.
 */
export const DEFAULT_ROOM_MAX_PAYLOAD_BYTES = 64 * 1024;

/** Default `RoomRegistryOptions.max_state_bytes`: a few flags, encoded. */
export const DEFAULT_ROOM_MAX_STATE_BYTES = 1024;

/** Default `RoomRegistryOptions.max_watches_per_connection`. */
export const DEFAULT_ROOM_MAX_WATCHES_PER_CONNECTION = 256;

// -- Refusal reasons ------------------------------------------------------------

/**
 * No such room, or one the caller may not join or watch (the IDOR mask), or
 * one an eviction closed to the request while it was in flight. A
 * `not_found`.
 */
export const ERROR_ROOM_NOT_FOUND = 'room_not_found' as const;
/** The room seats its maximum. A `conflict`. */
export const ERROR_ROOM_FULL = 'room_full' as const;
/** The caller's own leave of the room overtook the join. A `conflict`. */
export const ERROR_ROOM_JOIN_SUPERSEDED = 'room_join_superseded' as const;
/**
 * A rejoin names a seat that has moved since — its actor sits elsewhere now
 * (exclusive registries). A `conflict`.
 */
export const ERROR_ROOM_SEAT_MOVED = 'room_seat_moved' as const;
/** The caller's connection holds no seat in the room. A `conflict`. */
export const ERROR_ROOM_NOT_JOINED = 'room_not_joined' as const;
/** The addressee is not a member of the room, or is the sender's own seat. A `not_found`. */
export const ERROR_ROOM_MEMBER_NOT_FOUND = 'room_member_not_found' as const;
/** The payload is over the registry's bound. An `invalid_params`. */
export const ERROR_ROOM_PAYLOAD_TOO_LARGE = 'room_payload_too_large' as const;
/** The state is over the registry's bound. An `invalid_params`. */
export const ERROR_ROOM_STATE_TOO_LARGE = 'room_state_too_large' as const;
/** The connection watches its maximum of rooms. A `conflict`. */
export const ERROR_ROOM_WATCH_LIMIT = 'room_watch_limit' as const;

// -- Escaped length ---------------------------------------------------------------

/**
 * The most bytes one byte of a string can take escaped in a JSON frame:
 * `\u00XX`, for a control character without a two-byte escape. A lone
 * surrogate takes six too (`\udXXX`), from a single UTF-16 code unit.
 */
export const JSON_ESCAPE_MAX_EXPANSION = 6;

/**
 * The bytes `text` takes inside a JSON string in a frame — what the room
 * limiter charges a payload or state, and what the frame grows by. Twin of the
 * Rust `json_escaped_len`, byte for byte over well-formed text.
 *
 * `"` and `\` take 2; backspace, form feed, newline, carriage return, and tab
 * take 2 (`\b \f \n \r \t`); every other control character below U+0020 takes
 * 6 (`\u00XX`); everything else is its UTF-8 length — U+007F and non-ASCII
 * text are not escaped, U+2028 and U+2029 included. A surrogate pair is 4.
 *
 * A lone surrogate counts 6, which is what `JSON.stringify` writes for one
 * (`\udXXX`), so the count stays exactly the frame's growth for any string a
 * TS handler holds. A Rust string can't hold one, and no frame delivers one to
 * either spine: both refuse an escaped lone surrogate as a `parse_error`
 * (`http/json_text.ts`), and a raw one is invalid UTF-8 a WebSocket refuses.
 * So the twins never charge one differently over the wire.
 *
 * @param text - the payload or state
 * @returns its escaped length in bytes, without the surrounding quotes
 */
export const json_escaped_len = (text: string): number => {
	let bytes = 0;
	const length = text.length;
	for (let i = 0; i < length; i++) {
		const c = text.charCodeAt(i);
		if (c < 0x80) {
			if (c === 0x22 || c === 0x5c) bytes += 2;
			else if (c === 0x08 || c === 0x0c || c === 0x0a || c === 0x0d || c === 0x09) bytes += 2;
			else if (c < 0x20) bytes += 6;
			else bytes += 1;
		} else if (c < 0x800) {
			bytes += 2;
		} else if (c >= 0xd800 && c <= 0xdbff) {
			const next = i + 1 < length ? text.charCodeAt(i + 1) : 0;
			if (next >= 0xdc00 && next <= 0xdfff) {
				bytes += 4;
				i++;
			} else {
				bytes += 6;
			}
		} else if (c >= 0xdc00 && c <= 0xdfff) {
			bytes += 6;
		} else {
			bytes += 3;
		}
	}
	return bytes;
};

// -- Schemas --------------------------------------------------------------------

/**
 * A room's key — an opaque string the consumer chooses and parses (a voice
 * room keyed by a space id, say): 1 to `ROOM_ID_MAX_LENGTH` printable ASCII
 * characters (`!` through `~`, so no whitespace or control characters). ASCII
 * keeps the bound one number on both twins, where a UTF-16 length and a UTF-8
 * one would differ. Twin of the Rust `RoomId::parse`.
 */
export const RoomId = meta(
	pipe(string, min_length(1), max_length(ROOM_ID_MAX_LENGTH), regex(/^[!-~]+$/)),
	{ description: 'A room key: 1 to 128 printable ASCII characters, no spaces.' }
);
export type RoomId = Infer<typeof RoomId>;

/**
 * One seat's id — random per join, so a client addresses members without
 * ever seeing a connection id, and a rejoin gets a new one. A UUID on the wire.
 */
export const MemberId = meta(Uuid, { description: "A seat's id, random per join." });
export type MemberId = Infer<typeof MemberId>;

/** A room's `seq`: the count of its events, starting again at zero when the room is deleted. */
export const RoomSeq = pipe(number, safe_integer, min_value(0));
export type RoomSeq = Infer<typeof RoomSeq>;

/**
 * How a room's members reach each other's media — what the join answers, so
 * a client knows whom to connect to. `mesh`: every member connects to every
 * other; the server relays only the members' messages.
 */
export const RoomTopology = one_of(['mesh']);
export type RoomTopology = Infer<typeof RoomTopology>;

/**
 * Why a member left, as `room_member_left` says: `left` (it left),
 * `disconnected` (its socket closed), `moved` (its actor was seated elsewhere
 * on an exclusive registry, or its connection rejoined the room), `evicted`
 * (the consumer evicted it), `room_closed` (the consumer closed the room).
 */
export const RoomLeftReason = one_of(['left', 'disconnected', 'moved', 'evicted', 'room_closed']);
export type RoomLeftReason = Infer<typeof RoomLeftReason>;

/**
 * Why the server ended a seat, as `room_seat_lost` tells the seat's own
 * connection: `moved` (a newer seat took over; `moved_to` names its room),
 * `evicted`, `room_closed`.
 */
export const RoomSeatLostReason = one_of(['moved', 'evicted', 'room_closed']);
export type RoomSeatLostReason = Infer<typeof RoomSeatLostReason>;

/**
 * Why the consumer evicts — what members, seats, and watches are told:
 * `evicted` (the actor lost its access), `room_closed` (the room itself is
 * gone).
 */
export const RoomEvictReason = one_of(['evicted', 'room_closed']);
export type RoomEvictReason = Infer<typeof RoomEvictReason>;

/** One seated member, as members and watchers see it. */
export const RoomMember = object({
	member_id: MemberId,
	actor_id: Uuid,
	/** The member's client-encoded state, `null` until it sets one. */
	state: nullable(string)
});
export type RoomMember = Infer<typeof RoomMember>;

/**
 * A room's members as of `seq` — what a watch answers, and what
 * `RoomRegistry.occupancy` reads.
 */
export const RoomOccupancy = object({
	room_id: RoomId,
	seq: RoomSeq,
	members: array(RoomMember)
});
export type RoomOccupancy = Infer<typeof RoomOccupancy>;

// -- room_join ----------------------------------------------------------------------

/** Input for `room_join`. */
export const RoomJoinInput = object({
	room_id: RoomId,
	/** The member's initial state; omitted, `null` to the room until it sets one. */
	state: optional(string),
	/**
	 * The seat this join takes up again after a reconnect — refused as
	 * `room_seat_moved` on an exclusive registry when that seat has moved since.
	 */
	rejoin_of: optional(MemberId),
	acting: ActingActor
});
export type RoomJoinInput = Infer<typeof RoomJoinInput>;

/**
 * Output of `room_join`: the seat, and the room as of `seq` — the seq of the
 * joiner's own `room_member_joined`, so a client drops every buffered event at
 * or below it. `members` holds every member, the joiner included, in seating
 * order; `extra` is the consumer's `join_extra` value, `null` without one.
 */
export const RoomJoinOutput = object({
	room_id: RoomId,
	member_id: MemberId,
	seq: RoomSeq,
	members: array(RoomMember),
	topology: RoomTopology,
	extra: unknown
});
export type RoomJoinOutput = Infer<typeof RoomJoinOutput>;

/**
 * `room_join` — seat the caller in a room. Two phases on the server (a
 * reserve before the consumer's authorizer reads, an admit after), so an
 * eviction committing while the authorizer reads still reaches the join.
 * Charges the per-account rate-limit class (the authorizer reads the
 * database, and one account may hold many sockets) and the connection's room
 * limiter (one request, plus the state's escaped bytes).
 */
export const room_join_action_spec = {
	method: 'room_join',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'required', actor: 'required' },
	side_effects: false,
	input: RoomJoinInput,
	output: RoomJoinOutput,
	async: true,
	rate_limit: 'account',
	error_reasons: [
		ERROR_ROOM_NOT_FOUND,
		ERROR_ROOM_FULL,
		ERROR_ROOM_JOIN_SUPERSEDED,
		ERROR_ROOM_SEAT_MOVED,
		ERROR_ROOM_STATE_TOO_LARGE
	],
	description: "Seat the caller in a room; answers the room's members as of the join."
} as const satisfies RequestResponseActionSpec;

// -- room_leave ---------------------------------------------------------------------

/** Input for `room_leave`, `room_watch`, and `room_unwatch`. */
export const RoomIdInput = object({
	room_id: RoomId,
	acting: ActingActor
});
export type RoomIdInput = Infer<typeof RoomIdInput>;

/** Output of `room_leave`: whether it ended a seat or refused a join in flight. */
export const RoomLeaveOutput = object({ left: boolean });
export type RoomLeaveOutput = Infer<typeof RoomLeaveOutput>;

/**
 * `room_leave` — end the acting actor's seat in the room on this connection,
 * and refuse that actor's joins of the room still in flight on it. Idempotent.
 */
export const room_leave_action_spec = {
	method: 'room_leave',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'required', actor: 'required' },
	side_effects: false,
	input: RoomIdInput,
	output: RoomLeaveOutput,
	async: true,
	description: "End the caller's seat in a room."
} as const satisfies RequestResponseActionSpec;

// -- room_send ----------------------------------------------------------------------

/** Input for `room_send`. */
export const RoomSendInput = object({
	room_id: RoomId,
	/** The addressee's member id, or `null` for every other member of the room. Required. */
	to: nullable(MemberId),
	/** The client-encoded payload, at most the registry's `max_payload_bytes` in UTF-8. */
	payload: string,
	acting: ActingActor
});
export type RoomSendInput = Infer<typeof RoomSendInput>;

/**
 * `room_send` — relay a payload from the caller's seat to one member, or to
 * the room minus the sender (`room_message`). Watchers get no messages; a seat
 * never addresses itself (`room_member_not_found`). Charges the connection's
 * room limiter one request plus the payload's escaped bytes.
 */
export const room_send_action_spec = {
	method: 'room_send',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'required', actor: 'required' },
	side_effects: false,
	input: RoomSendInput,
	output: literal(null),
	async: true,
	error_reasons: [ERROR_ROOM_NOT_JOINED, ERROR_ROOM_MEMBER_NOT_FOUND, ERROR_ROOM_PAYLOAD_TOO_LARGE],
	description: 'Relay a payload to one member of a room, or to every other member.'
} as const satisfies RequestResponseActionSpec;

// -- room_state_set -----------------------------------------------------------------

/** Input for `room_state_set`. */
export const RoomStateSetInput = object({
	room_id: RoomId,
	/** The client-encoded state, at most the registry's `max_state_bytes` in UTF-8. */
	state: string,
	acting: ActingActor
});
export type RoomStateSetInput = Infer<typeof RoomStateSetInput>;

/** Output of `room_state_set`: the seq of the `room_member_state` it caused. */
export const RoomStateSetOutput = object({ seq: RoomSeq });
export type RoomStateSetOutput = Infer<typeof RoomStateSetOutput>;

/**
 * `room_state_set` — set the caller's member state, telling the other members
 * and the watchers (`room_member_state`). Charges the connection's room limiter
 * one request plus the state's escaped bytes.
 */
export const room_state_set_action_spec = {
	method: 'room_state_set',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'required', actor: 'required' },
	side_effects: false,
	input: RoomStateSetInput,
	output: RoomStateSetOutput,
	async: true,
	error_reasons: [ERROR_ROOM_NOT_JOINED, ERROR_ROOM_STATE_TOO_LARGE],
	description: "Set the caller's member state in a room."
} as const satisfies RequestResponseActionSpec;

// -- room_watch / room_unwatch ----------------------------------------------------

/**
 * `room_watch` — see a room's members without joining: answers its occupancy,
 * then the member events. Two phases like a join, and on the per-account
 * rate-limit class; a watch fans out nothing, so the room limiter doesn't
 * charge it. Watching a room already watched answers its occupancy again.
 */
export const room_watch_action_spec = {
	method: 'room_watch',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'required', actor: 'required' },
	side_effects: false,
	input: RoomIdInput,
	output: RoomOccupancy,
	async: true,
	rate_limit: 'account',
	error_reasons: [ERROR_ROOM_NOT_FOUND, ERROR_ROOM_WATCH_LIMIT],
	description: "Watch a room's members without joining."
} as const satisfies RequestResponseActionSpec;

/** Output of `room_unwatch`: whether the connection was watching. */
export const RoomUnwatchOutput = object({ unwatched: boolean });
export type RoomUnwatchOutput = Infer<typeof RoomUnwatchOutput>;

/** `room_unwatch` — stop watching a room. Idempotent. */
export const room_unwatch_action_spec = {
	method: 'room_unwatch',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'required', actor: 'required' },
	side_effects: false,
	input: RoomIdInput,
	output: RoomUnwatchOutput,
	async: true,
	description: 'Stop watching a room.'
} as const satisfies RequestResponseActionSpec;

/** The room verbs, in the order `create_room_actions` builds them. */
export const all_room_action_specs = [
	room_join_action_spec,
	room_leave_action_spec,
	room_send_action_spec,
	room_state_set_action_spec,
	room_watch_action_spec,
	room_unwatch_action_spec
] as const;

// -- Notifications ----------------------------------------------------------------

/** Params of `room_member_joined`. */
export const RoomMemberJoinedParams = object({
	room_id: RoomId,
	seq: RoomSeq,
	member: RoomMember
});
export type RoomMemberJoinedParams = Infer<typeof RoomMemberJoinedParams>;

/** Params of `room_member_left`. */
export const RoomMemberLeftParams = object({
	room_id: RoomId,
	seq: RoomSeq,
	member_id: MemberId,
	reason: RoomLeftReason
});
export type RoomMemberLeftParams = Infer<typeof RoomMemberLeftParams>;

/** Params of `room_member_state`. */
export const RoomMemberStateParams = object({
	room_id: RoomId,
	seq: RoomSeq,
	member_id: MemberId,
	state: nullable(string)
});
export type RoomMemberStateParams = Infer<typeof RoomMemberStateParams>;

/** Params of `room_message`: `to` is `null` for a room-wide send. */
export const RoomMessageParams = object({
	room_id: RoomId,
	seq: RoomSeq,
	from: MemberId,
	to: nullable(MemberId),
	payload: string
});
export type RoomMessageParams = Infer<typeof RoomMessageParams>;

/** Params of `room_seat_lost`: `moved_to` names the new seat's room for `moved`, else `null`. */
export const RoomSeatLostParams = object({
	room_id: RoomId,
	member_id: MemberId,
	reason: RoomSeatLostReason,
	moved_to: nullable(RoomId)
});
export type RoomSeatLostParams = Infer<typeof RoomSeatLostParams>;

/** Params of `room_watch_ended`. */
export const RoomWatchEndedParams = object({
	room_id: RoomId,
	reason: RoomEvictReason
});
export type RoomWatchEndedParams = Infer<typeof RoomWatchEndedParams>;

/** A member was seated — to the room's other members and its watchers. */
export const room_member_joined_notification_spec = {
	method: 'room_member_joined',
	kind: 'remote_notification',
	initiator: 'backend',
	auth: null,
	side_effects: true,
	input: RoomMemberJoinedParams,
	output: fuz_void,
	async: true,
	description: 'A member was seated in the room — to its other members and its watchers.'
} satisfies RemoteNotificationActionSpec;

/** A member's seat ended — to the room's remaining members and its watchers. */
export const room_member_left_notification_spec = {
	method: 'room_member_left',
	kind: 'remote_notification',
	initiator: 'backend',
	auth: null,
	side_effects: true,
	input: RoomMemberLeftParams,
	output: fuz_void,
	async: true,
	description: "A member's seat ended — to the room's remaining members and its watchers."
} satisfies RemoteNotificationActionSpec;

/** A member set its state — to the room's other members and its watchers. */
export const room_member_state_notification_spec = {
	method: 'room_member_state',
	kind: 'remote_notification',
	initiator: 'backend',
	auth: null,
	side_effects: true,
	input: RoomMemberStateParams,
	output: fuz_void,
	async: true,
	description: "A member set its state — to the room's other members and its watchers."
} satisfies RemoteNotificationActionSpec;

/** A member's payload — to its addressee, or to the room minus its sender. */
export const room_message_notification_spec = {
	method: 'room_message',
	kind: 'remote_notification',
	initiator: 'backend',
	auth: null,
	side_effects: true,
	input: RoomMessageParams,
	output: fuz_void,
	async: true,
	description: "A member's payload — to its addressee, or to the room minus its sender."
} satisfies RemoteNotificationActionSpec;

/** The server ended a seat — to the seat's own connection. */
export const room_seat_lost_notification_spec = {
	method: 'room_seat_lost',
	kind: 'remote_notification',
	initiator: 'backend',
	auth: null,
	side_effects: true,
	input: RoomSeatLostParams,
	output: fuz_void,
	async: true,
	description: "The server ended a seat — to the seat's own connection."
} satisfies RemoteNotificationActionSpec;

/** The server ended a watch — to the watcher. */
export const room_watch_ended_notification_spec = {
	method: 'room_watch_ended',
	kind: 'remote_notification',
	initiator: 'backend',
	auth: null,
	side_effects: true,
	input: RoomWatchEndedParams,
	output: fuz_void,
	async: true,
	description: 'The server ended a watch — to the watcher.'
} satisfies RemoteNotificationActionSpec;

/** The room notifications. */
export const room_notification_action_specs: ReadonlyArray<RemoteNotificationActionSpec> = [
	room_member_joined_notification_spec,
	room_member_left_notification_spec,
	room_member_state_notification_spec,
	room_message_notification_spec,
	room_seat_lost_notification_spec,
	room_watch_ended_notification_spec
];

/**
 * The room notifications as handler-less actions, for a WS endpoint's action
 * list beside `create_room_actions`' verbs, so its surface lists what the
 * registry pushes as `remote_notification` methods. With no handler they never
 * reach dispatch: an inbound frame for one is answered `method_not_found`.
 */
export const room_notification_actions: ReadonlyArray<Action> = room_notification_action_specs.map(
	(spec) => ({ spec })
);

/**
 * Every room spec, verbs then notifications — for a frontend `ActionRegistry`,
 * so a client both calls the verbs and receives the notifications.
 */
export const all_room_specs: ReadonlyArray<ActionSpecUnion> = [
	...all_room_action_specs,
	...room_notification_action_specs
];
