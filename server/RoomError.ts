/** Kesalahan yang pantas diteruskan ke client sebagai pesan 'error'. */
export class RoomError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}
