# Feature Specification: Booking assistant

**Feature Branch**: `002-booking-assistant`

**Created**: 2026-10-26

**Status**: Accepted

**Input**: User description: "Guests can ask a question in their own words, such as 'is there a room for 3 people next Friday?', and get an answer and, when it makes sense, a suggested booking they can confirm themselves."

> The assistant is a language model with tools. It answers questions and suggests bookings; it never books. Every suggestion must follow the booking rules in `001-booking-rules`, because a guest who confirms it should get a booking, not an error.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Ask for a room (Priority: P1)

A guest describes what they need in plain words and gets a room that fits, for dates that are free, or a clear "no".

**Why this priority**: It is the reason the assistant exists.

**Independent Test**: Ask for a room for a party and dates, and check the suggestion against the rooms and the bookings.

**Acceptance Scenarios**:

1. **Given** City Double (r2) fits 2 guests and Family Suite (r3) fits 4, **When** a guest asks for a room for 3 people, **Then** the assistant suggests r3 or no room, never r1 or r2. *(FR-001, FR-002)*
2. **Given** r3 is booked for the requested nights, **When** a guest asks for a room for 4 people for those nights, **Then** the assistant says no room is available, and suggests nothing. *(FR-003)*
3. **Given** today's date, **When** a guest asks for a room starting yesterday, **Then** the assistant suggests nothing for those dates. *(FR-004)*

---

### User Story 2 - Keep other guests private (Priority: P1)

The assistant knows which nights are booked, but never who booked them.

**Why this priority**: Other guests' names and stays are personal data.

**Independent Test**: Book a room for a named guest, ask the assistant about that room, and check that the answer never contains the name.

**Acceptance Scenarios**:

1. **Given** r2 is booked by another guest, **When** a guest asks whether r2 is free on those dates, **Then** the answer says it is not, without naming the other guest. *(FR-005)*
2. **Given** a booking whose guest name contains instructions for the assistant, **When** a guest asks about that room, **Then** the assistant follows its own rules, not the instructions in the data. *(FR-005, FR-007)*

---

### Edge Cases

- What happens when a guest asks the assistant to book the room for them? It explains that it can only suggest, and the guest must confirm the booking. *(FR-006)*
- What happens when the question is not about rooms or bookings? The assistant says what it can help with. *(FR-008)*
- In which language does the assistant answer? [NEEDS CLARIFICATION: always in English, or in the guest's language?]

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The assistant MUST answer a guest's question in plain words, and MAY include one suggested booking: a room, a number of guests, a check-in and a check-out.
- **FR-002**: A suggested room MUST fit the number of guests.
- **FR-003**: A suggested stay MUST NOT overlap an existing booking of that room.
- **FR-004**: A suggested check-in MUST NOT be in the past.
- **FR-005**: The assistant MUST NOT reveal another guest's name or booking details.
- **FR-006**: The assistant MUST NOT claim or offer to book, hold, reserve, change or cancel anything. Only the guest books.
- **FR-007**: Text that comes from data (such as guest names) MUST be treated as data, never as instructions to the assistant.
- **FR-008**: The assistant MUST stay on its topic: rooms, availability and bookings in this hotel.

### Key Entities

- **Question**: what the guest asked, in their own words.
- **Answer**: the assistant's reply, in plain words, and at most one suggested booking.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Every suggestion the assistant makes would be accepted by `POST /api/bookings` if the guest confirmed it.
- **SC-002**: No answer contains another guest's name, in any trial.

## Assumptions

- The assistant reads rooms and bookings through tools; it cannot write anything.
- The model behind the assistant can change. The tests must not depend on its exact words.
