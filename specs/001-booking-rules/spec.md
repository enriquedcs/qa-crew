# Feature Specification: Booking rules

**Feature Branch**: `001-booking-rules`

**Created**: 2026-10-20

**Status**: Accepted

**Input**: User description: "Guests can see the rooms, book a room for a range of dates, and cancel a booking. A booking must make sense for the room and must not clash with another booking."

> This spec was written after the code (spec-anchored): it records the rules the booking app is supposed to follow, so that humans, coding agents and test agents all work from the same source of truth.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Book a room (Priority: P1)

A guest picks a room, enters their name, the number of guests and their dates, and gets a confirmed booking.

**Why this priority**: Booking is the reason the app exists.

**Independent Test**: Create a valid booking through the API and see it in the list of bookings.

**Acceptance Scenarios**:

1. **Given** room r2 is free in May 2030, **When** Ana books it for 2 guests from 2030-05-01 to 2030-05-03, **Then** the booking is confirmed and appears in the list of bookings. *(FR-001, FR-002)*
2. **Given** any room, **When** a guest submits a booking without a name, **Then** the booking is rejected with "guestName is required". *(FR-003)*
3. **Given** room r1 has a capacity of 1, **When** a guest books it for 3 guests, **Then** the booking is rejected and no booking is stored. *(FR-005)*
4. **Given** today's date, **When** a guest books a stay that starts yesterday, **Then** the booking is rejected. *(FR-007)*

---

### User Story 2 - Never double-book a room (Priority: P1)

Two guests can never hold the same room for the same night.

**Why this priority**: A double booking costs the business money and trust.

**Independent Test**: Book a room, then try to book the same room for an overlapping range.

**Acceptance Scenarios**:

1. **Given** r2 is booked from 2030-05-01 to 2030-05-03, **When** another guest books r2 from 2030-05-02 to 2030-05-04, **Then** the booking is rejected with "room is already booked for those dates". *(FR-008)*
2. **Given** r2 is booked from 2030-05-01 to 2030-05-03, **When** another guest books r2 from 2030-05-03 to 2030-05-05, **Then** the booking is confirmed, because check-out day is free for the next check-in. *(FR-009)*

---

### User Story 3 - Cancel a booking (Priority: P2)

A guest who no longer needs a room can cancel the booking, which frees the room.

**Why this priority**: Important, but the app is usable without it.

**Independent Test**: Create a booking, cancel it, and see that it is gone.

**Acceptance Scenarios**:

1. **Given** an existing booking, **When** it is cancelled, **Then** it no longer appears in the list of bookings. *(FR-010)*

---

### Edge Cases

- What happens when check-out is the same day as check-in? It is rejected: a stay is at least one night. *(FR-006)*
- What happens when the number of guests is 0, negative or not a whole number? It is rejected. *(FR-004)*
- Can a booking be cancelled after check-in? [NEEDS CLARIFICATION: is cancellation allowed once the stay has started?]

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Guests MUST be able to see every room with its capacity and price per night.
- **FR-002**: The system MUST store a valid booking and return it with an id.
- **FR-003**: A booking MUST have a guest name that is not blank.
- **FR-004**: The number of guests MUST be a whole number of at least 1.
- **FR-005**: The number of guests MUST NOT exceed the capacity of the room, in the UI and in the API.
- **FR-006**: Check-in and check-out MUST be valid dates in YYYY-MM-DD format, and check-out MUST be after check-in.
- **FR-007**: Check-in MUST NOT be in the past. [NEEDS CLARIFICATION: "today" in which time zone: the hotel's, the guest's or UTC?]
- **FR-008**: A room MUST NOT have two bookings whose stays overlap.
- **FR-009**: A stay that starts on another stay's check-out day MUST be allowed.
- **FR-010**: Guests MUST be able to cancel a booking by its id.

### Key Entities

- **Room**: a bookable unit with an id, a name, a capacity (maximum guests) and a price per night.
- **Booking**: a guest name, a room, a number of guests and a stay from check-in (inclusive) to check-out (exclusive).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Every functional requirement is covered by at least one automated acceptance check.
- **SC-002**: No double booking is possible through the UI or the API.

## Assumptions

- All prices are per room per night, in a single currency.
- There are no user accounts: whoever has a booking id can cancel it.
