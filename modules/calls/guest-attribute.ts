/**
 * The LiveKit participant attribute that marks someone outside the company.
 * The server puts it into a guest's join token (livekit.ts mintGuestToken);
 * the browser reads it to label the tile "Guest" (src/lib/calls/livekit-room.ts).
 * No dependencies: the browser bundle imports this file.
 */
export const GUEST_ATTRIBUTE = 'ee.role'
export const GUEST_ROLE = 'guest'
