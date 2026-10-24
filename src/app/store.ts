// In-memory data for the booking app.
// Everything resets when the server starts, so readers can break it freely.

export interface Room {
  id: string;
  name: string;
  capacity: number;
  pricePerNight: number;
}

export interface Booking {
  id: string;
  roomId: string;
  guestName: string;
  guests: number;
  checkIn: string; // YYYY-MM-DD
  checkOut: string; // YYYY-MM-DD
  createdAt: string;
}

export interface NewBooking {
  roomId: string;
  guestName: string;
  guests: number;
  checkIn: string;
  checkOut: string;
}

const seedRooms: Room[] = [
  { id: "r1", name: "Garden Single", capacity: 1, pricePerNight: 80 },
  { id: "r2", name: "City Double", capacity: 2, pricePerNight: 120 },
  { id: "r3", name: "Family Suite", capacity: 4, pricePerNight: 210 },
];

export class Store {
  private rooms: Room[] = [];
  private bookings: Booking[] = [];
  private nextId = 1;

  constructor() {
    this.reset();
  }

  reset(): void {
    this.rooms = seedRooms.map((r) => ({ ...r }));
    this.bookings = [];
    this.nextId = 1;
  }

  listRooms(): Room[] {
    return this.rooms;
  }

  getRoom(id: string): Room | undefined {
    return this.rooms.find((r) => r.id === id);
  }

  listBookings(): Booking[] {
    return this.bookings;
  }

  getBooking(id: string): Booking | undefined {
    return this.bookings.find((b) => b.id === id);
  }

  bookingsForRoom(roomId: string): Booking[] {
    return this.bookings.filter((b) => b.roomId === roomId);
  }

  addBooking(input: NewBooking): Booking {
    const booking: Booking = {
      id: `b${this.nextId++}`,
      ...input,
      createdAt: new Date().toISOString(),
    };
    this.bookings.push(booking);
    return booking;
  }

  deleteBooking(id: string): boolean {
    const before = this.bookings.length;
    this.bookings = this.bookings.filter((b) => b.id !== id);
    return this.bookings.length < before;
  }
}
