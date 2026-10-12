// "Today" is the user's local calendar date, not the UTC one: a purchase on the evening of the 31st in Los Angeles,
// or on the morning of the 1st in Auckland, belongs to the month the user sees on their own calendar.
const pad = (n) => String(n).padStart(2, '0');
const localDate = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/** Shift a YYYY-MM-DD date by whole days (calendar arithmetic, no timezone involved). */
const shiftDays = (s, n) => new Date(Date.parse(s) + n * 864e5).toISOString().slice(0, 10);
module.exports = { today: () => localDate(), localDate, shiftDays };
