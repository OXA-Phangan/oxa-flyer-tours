/**
 * Texts of the public registration form that OXA can edit in the admin
 * (Crew → Registrations → Settings). Stored at flyerSettings/registration:
 *   termsText            Volunteer Terms & Conditions (plain text, blank line = new paragraph)
 *   confirmationMessage  shown after a registration was sent ("{name}" = the volunteer's first name)
 * The defaults below are used until something was saved (or if the doc can't be read).
 */

export const DEFAULT_CONFIRMATION_MESSAGE =
  "Your registration is being reviewed by the OXA team. You'll receive your personal Flyer Tours link via WhatsApp once it's approved.";

export const DEFAULT_TERMS_TEXT = `1. Scope of Volunteering: The Volunteer agrees to perform tasks or duties in exchange for free accommodation. Tasks and duties can vary but will mostly be in the field of event promotion.
The Host agrees to provide the Volunteer with free accommodation for 7 days in exchange for a maximum of 25h/week. The Volunteer shall be entitled to 7 days of free accommodation for completing the agreed-upon hours. One day of accommodation equals 3.57h of tasks (7 days = 25h).

2. Accommodation Details: The Volunteer receives a private bunk bed in a shared bedroom, including air conditioning and a fan. The Volunteer gets access to a private locker to store all valuables, a bathroom, balcony, and the wifi. The Volunteer is free to use the kitchen as well.
The Host is obligated by immigration law to verify the Volunteer's identity by taking a copy or picture of the passport. The Volunteer agrees to the house rules and ensures to follow them (see section 8). Violation of the house rules can lead to disciplinary measures such as cleaning or additional task hours.
The Volunteer needs to leave a deposit of 1000THB or Passport to the Host as a security deposit for either key loss, damages to the Host's property, theft, or other damages. After the successful end of the Volunteering agreement, the Volunteer will receive back the deposit at the check-out. Before check-out, the Volunteer ensures to return all keys to the Host and leaves the facility in the same condition as moved in. If there is an open balance for any damage, early departure, key loss, or bike rental, the Volunteer ensures to pay the balance before departure. Bed sheets shall be taken off by the Volunteer before check-out.

3. Responsibilities: Both parties agree to fulfill their responsibilities as outlined in this Agreement. The Volunteer agrees to perform the assigned tasks diligently and in a timely manner, and the Host agrees to provide suitable accommodation.

4. Tasking Hours: A regular week will have 3 tasks days, starting on Wednesday. After that, the Volunteer will have 4 days off. Each task day has 4-7 task hours and a 1-hour break (split into 2x 30 minutes).
Example schedule of a regular week:
Wednesday: 3-8 PM
Thursday: 1-9 PM
Friday: 1-9 PM
Sat-Tue: Free Time
The full detailed schedule will be provided by the Host at the beginning of each task day. Volunteers are advised to be ready to leave the house at the specified time. A late start will result in a later end of tasks. Break times will be specified within the schedule. Regular weeks are weeks where the event takes place on a Friday. During the Full Moon week when the legendary Full Moon Party takes place, it might come to a different day or even two events in one week (irregular week). In this case, the schedule will change accordingly, but the Volunteer will not exceed the maximum of 25 hours per week. The Volunteer and Host can agree to additional tasks / hours for either a longer stay or using the bike for free time. Details for extra hours need to be discussed between the Volunteer and Host depending on the situation.

5. Duration of Stay and Payment for Early Departure: The Volunteer agrees to provide services for a maximum of 25 hours per week during the agreed-upon period. If the Volunteer chooses to leave early and has consumed more free accommodation days than the completed hours justify, the Volunteer shall compensate the Host for the remaining days at the rate of 400THB/day.
Example: The Volunteer arrives on Friday and leaves on Tuesday. The Volunteer used 4 days (nights) of free accommodation but only served 1 day for tasks (7 hours). One day of accommodation equals 3.57h, so then 4 days of stay equals 14 hours of tasks. The Volunteer owes the Host 7 more hours which equal 2 days of accommodation (2x400 = 800THB).

6. Termination: The agreement will end automatically on the agreed End of Stay. The Volunteering agreement can be terminated early if both Host and Volunteer agree on it. The Host can end the Volunteering before the end of stay if the Volunteer violates the agreement.

7. Confidentiality: The Volunteer agrees not to disclose any information about the Host, obtained knowledge, or the Volunteering Agreement to any third party.

8. House Rules

General:
No outside guests.
No party or loud music inside.
No food/trash in the dorm (ants!!).
Keep your valuables in your locker.
Damages to furniture need to be reported.
Leave your shoes outside (only one pair per person).
Lock the office door anytime you leave.

Kitchen:
Clean your dishes and surfaces directly after using.
Don't leave any food open (ants!!).
Put all leftovers/trash in plastic bags and put them in the bin outside (ants!!).
Empty the bin whenever it's full and put a new bag inside.

Bathroom:
Never flush toilet paper. Put it in the bin instead.
Empty the bin whenever it's full and put a new bag inside.
Dry your wet towels on the balcony.
Mark your shampoo and stuff.

Bike/Scooter:
Fill up gasoline to the same level as you received it.
Any damages need to be reported and fixed.
We keep your passport as a safety deposit when using it for free time.
Check brakes and tires before you drive.
Don't lose the key.`;

export type RegistrationSettings = { termsText: string; confirmationMessage: string };

export const DEFAULT_REGISTRATION_SETTINGS: RegistrationSettings = {
  termsText: DEFAULT_TERMS_TEXT,
  confirmationMessage: DEFAULT_CONFIRMATION_MESSAGE,
};

/** Merges a stored doc with the defaults (empty / missing fields fall back). */
export function parseRegistrationSettings(data: Record<string, unknown> | undefined): RegistrationSettings {
  const terms = typeof data?.termsText === "string" ? data.termsText.trim() : "";
  const msg = typeof data?.confirmationMessage === "string" ? data.confirmationMessage.trim() : "";
  return {
    termsText: terms || DEFAULT_TERMS_TEXT,
    confirmationMessage: msg || DEFAULT_CONFIRMATION_MESSAGE,
  };
}
