/**
 * Shared cryptographic utilities.
 *
 * @module
 */

/**
 * Generate a cryptographically random base64url string.
 *
 * @param byte_length - number of random bytes (default 32 = 256 bits)
 * @returns base64url-encoded string without padding
 */
export const generate_random_base64url = (byte_length = 32): string => {
	const bytes = new Uint8Array(byte_length);
	crypto.getRandomValues(bytes);
	return btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');
};
