/**
 * FastCGI protocol constants as defined in the specification (section 8).
 * https://fast-cgi.github.io/spec
 */

/** Protocol version this library implements. */
export const FCGI_VERSION_1 = 1;

/** Fixed byte length of every FastCGI record header. */
export const FCGI_HEADER_LEN = 8;

/** requestId value used for management records (not tied to any request). */
export const FCGI_NULL_REQUEST_ID = 0;

// ---------------------------------------------------------------------------
// Record types (type component of FCGI_Header)
// ---------------------------------------------------------------------------

export const RecordType = {
	BEGIN_REQUEST: 1,
	ABORT_REQUEST: 2,
	END_REQUEST: 3,
	PARAMS: 4,
	STDIN: 5,
	STDOUT: 6,
	STDERR: 7,
	DATA: 8,
	GET_VALUES: 9,
	GET_VALUES_RESULT: 10,
	UNKNOWN_TYPE: 11,
} as const;

export type RecordType = (typeof RecordType)[keyof typeof RecordType];

export const FCGI_MAXTYPE = RecordType.UNKNOWN_TYPE;

// ---------------------------------------------------------------------------
// Roles (role component of FCGI_BeginRequestBody)
// ---------------------------------------------------------------------------

export const Role = {
	RESPONDER: 1,
	AUTHORIZER: 2,
	FILTER: 3,
} as const;

export type Role = (typeof Role)[keyof typeof Role];

// ---------------------------------------------------------------------------
// Flags (flags component of FCGI_BeginRequestBody)
// ---------------------------------------------------------------------------

/** If set, the application must not close the connection after responding. */
export const FCGI_KEEP_CONN = 1;

// ---------------------------------------------------------------------------
// Protocol status (protocolStatus component of FCGI_EndRequestBody)
// ---------------------------------------------------------------------------

export const ProtocolStatus = {
	REQUEST_COMPLETE: 0,
	CANT_MPX_CONN: 1,
	OVERLOADED: 2,
	UNKNOWN_ROLE: 3,
} as const;

export type ProtocolStatus = (typeof ProtocolStatus)[keyof typeof ProtocolStatus];

// ---------------------------------------------------------------------------
// FCGI_GET_VALUES variable names
// ---------------------------------------------------------------------------

export const FCGI_MAX_CONNS = "FCGI_MAX_CONNS";
export const FCGI_MAX_REQS = "FCGI_MAX_REQS";
export const FCGI_MPXS_CONNS = "FCGI_MPXS_CONNS";
