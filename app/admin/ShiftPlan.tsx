"use client";

import { useEffect, useMemo, useState } from "react";
import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  onSnapshot,
  query,
  serverTimestamp,
  updateDoc,
  where,
  writeBatch,
} from "firebase/firestore";
import { db } from "@/lib/firebase";
import {
  addDays,
  bangkokToday,
  compareShifts,
  dayMonth,
  dowShort,
  longDayLabel,
  tourLabel,
  weekStart,
  type FlyerShift,
} from "@/lib/shifts";

type Vol = { id: string; name: string; checkInDate: string; checkOutDate: string };
type RouteOpt = { id: string; region: string; name: string };

type EditorState = {
  mode: "new" | "edit";
  shiftId: string | null;
  volunteerId: string;
  date: string;
  startTime: string;
  endTime: string;
  tourId: string;
  note: string;
  repeat: string[];
  /** Other volunteers who do the same shift (new shifts only). */
  team: string[];
  /** True once the admin changed a time by hand — tour presets then stop overwriting it. */
  timesTouched: boolean;
  /** Opened via the top "+ Add shift" button: volunteer and date are chosen in the dialog. */
  pick: boolean;
};

// Standard shift times per tour type. Full day 13:00–21:00, everything else
// (half day, starter) 15:00–20:00. Still adjustable in the dialog.
function tourTimes(tourName: string | undefined): { start: string; end: string } {
  if ((tourName ?? "").toLowerCase().includes("full")) return { start: "13:00", end: "21:00" };
  return { start: "15:00", end: "20:00" };
}

const fieldInput =
  "block w-full min-w-0 appearance-none rounded-xl border border-[#E2DFD6] bg-white px-4 py-3 text-base text-[#201E1B] min-h-[50px] focus:border-[#201E1B] focus:outline-none disabled:bg-[#FBF9F4] disabled:text-[#5C5850]";
const fieldLabel = "mb-1.5 block text-sm font-medium text-[#201E1B]";
const primaryButton =
  "rounded-2xl bg-[#201E1B] px-5 py-3 text-base font-semibold text-white disabled:opacity-40";
const secondaryButton =
  "rounded-2xl border border-[#E2DFD6] bg-white px-5 py-3 text-base font-semibold text-[#201E1B] disabled:opacity-40";

export default function ShiftPlan({ adminEmail }: { adminEmail: string }) {
  const todayStr = bangkokToday();
  const [start, setStart] = useState(() => weekStart(bangkokToday()));
  const [volunteers, setVolunteers] = useState<Vol[] | null>(null);
  const [routes, setRoutes] = useState<RouteOpt[]>([]);
  const [shiftsByVol, setShiftsByVol] = useState<Record<string, FlyerShift[]>>({});
  const [loadError, setLoadError] = useState<string | null>(null);

  const [editor, setEditor] = useState<EditorState | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(start, i)), [start]);
  const end = days[6];

  // ---- Volunteers ----
  useEffect(() => {
    return onSnapshot(
      collection(db, "flyerVolunteers"),
      (snap) => {
        setVolunteers(
          snap.docs.map((d) => {
            const data = d.data() as { name?: string; checkInDate?: string; checkOutDate?: string };
            return {
              id: d.id,
              name: data.name ?? "(no name)",
              checkInDate: data.checkInDate ?? "",
              checkOutDate: data.checkOutDate ?? "",
            };
          })
        );
        setLoadError(null);
      },
      (err) => {
        console.error("[admin] shift plan volunteers failed:", err);
        setLoadError(err.code === "permission-denied" ? "Permission denied loading volunteers." : err.message);
      }
    );
  }, []);

  // ---- Tours for the picker ----
  useEffect(() => {
    let cancelled = false;
    getDocs(collection(db, "flyerRoutes"))
      .then((snap) => {
        if (cancelled) return;
        const list = snap.docs.map((d) => {
          const data = d.data() as { region?: string; name?: string };
          return { id: d.id, region: data.region ?? "", name: data.name ?? "" };
        });
        list.sort((a, b) => a.region.localeCompare(b.region) || a.name.localeCompare(b.name));
        setRoutes(list);
      })
      .catch((err) => console.error("[admin] shift plan routes failed:", err));
    return () => {
      cancelled = true;
    };
  }, []);

  // Volunteers whose stay overlaps the visible week.
  const visible = useMemo(() => {
    return (volunteers ?? [])
      .filter((v) => v.checkOutDate >= start && v.checkInDate <= end)
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [volunteers, start, end]);
  const visibleKey = visible.map((v) => v.id).join(",");

  // ---- Shifts: one listener per visible volunteer (the data lives in a
  // per-volunteer subcollection) for the visible week only ----
  useEffect(() => {
    const ids = visibleKey ? visibleKey.split(",") : [];
    setShiftsByVol({});
    const unsubs = ids.map((id) =>
      onSnapshot(
        query(
          collection(db, "flyerVolunteers", id, "shifts"),
          where("date", ">=", start),
          where("date", "<=", end)
        ),
        (snap) => {
          const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }) as FlyerShift);
          setShiftsByVol((prev) => ({ ...prev, [id]: list }));
        },
        (err) => {
          console.error("[admin] shift plan shifts failed:", err);
          setLoadError(err.code === "permission-denied" ? "Permission denied loading shifts." : err.message);
        }
      )
    );
    return () => unsubs.forEach((u) => u());
  }, [visibleKey, start, end]);

  function openNew(volunteerId?: string, date?: string) {
    const fallbackDate = todayStr >= start && todayStr <= end ? todayStr : start;
    setFormError(null);
    setConfirmDelete(false);
    setEditor({
      mode: "new",
      shiftId: null,
      volunteerId: volunteerId ?? visible[0]?.id ?? "",
      date: date ?? fallbackDate,
      startTime: tourTimes(undefined).start,
      endTime: tourTimes(undefined).end,
      tourId: "",
      note: "",
      repeat: [],
      team: [],
      timesTouched: false,
      pick: !volunteerId,
    });
  }

  function openEdit(s: FlyerShift) {
    setFormError(null);
    setConfirmDelete(false);
    setEditor({
      mode: "edit",
      shiftId: s.id,
      volunteerId: s.volunteerToken,
      date: s.date,
      startTime: s.startTime,
      endTime: s.endTime,
      tourId: s.tourId ?? "",
      note: s.note ?? "",
      repeat: [],
      team: [],
      timesTouched: true,
      pick: false,
    });
  }

  function chooseTour(tourId: string) {
    setEditor((e) => {
      if (!e) return e;
      if (e.timesTouched) return { ...e, tourId };
      const t = tourTimes(routes.find((r) => r.id === tourId)?.name);
      return { ...e, tourId, startTime: t.start, endTime: t.end };
    });
  }

  function closeEditor() {
    if (busy) return;
    setEditor(null);
    setConfirmDelete(false);
  }

  function patch(p: Partial<EditorState>) {
    setEditor((e) => (e ? { ...e, ...p } : e));
  }

  async function save() {
    if (!editor) return;
    const vol = (volunteers ?? []).find((v) => v.id === editor.volunteerId);
    if (!vol) return setFormError("Please choose a volunteer.");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(editor.date)) return setFormError("Please choose a date.");
    if (!editor.startTime || !editor.endTime) return setFormError("Please set a start and end time.");
    if (editor.endTime <= editor.startTime) return setFormError("The end time must be after the start time.");

    const route = routes.find((r) => r.id === editor.tourId) ?? null;
    const common = {
      startTime: editor.startTime,
      endTime: editor.endTime,
      tourId: route?.id ?? null,
      tourName: route?.name ?? null,
      tourRegion: route?.region ?? null,
      note: editor.note.trim() || null,
    };
    const base = { ...common, volunteerToken: vol.id, volunteerName: vol.name };

    setBusy(true);
    setFormError(null);
    try {
      if (editor.mode === "new") {
        const dates = Array.from(new Set([editor.date, ...editor.repeat]));
        const people = [vol, ...(volunteers ?? []).filter((v) => v.id !== vol.id && editor.team.includes(v.id))];
        const batch = writeBatch(db);
        for (const person of people) {
          for (const date of dates) {
            batch.set(doc(collection(db, "flyerVolunteers", person.id, "shifts")), {
              ...common,
              volunteerToken: person.id,
              volunteerName: person.name,
              date,
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
              createdBy: adminEmail,
            });
          }
        }
        await batch.commit();
      } else if (editor.shiftId) {
        await updateDoc(doc(db, "flyerVolunteers", vol.id, "shifts", editor.shiftId), {
          ...base,
          date: editor.date,
          updatedAt: serverTimestamp(),
        });
      }
      setEditor(null);
    } catch (err) {
      console.error("[admin] saving shift failed:", err);
      setFormError("Saving failed. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function removeShift() {
    if (!editor || editor.mode !== "edit" || !editor.shiftId) return;
    setBusy(true);
    setFormError(null);
    try {
      await deleteDoc(doc(db, "flyerVolunteers", editor.volunteerId, "shifts", editor.shiftId));
      setEditor(null);
      setConfirmDelete(false);
    } catch (err) {
      console.error("[admin] deleting shift failed:", err);
      setFormError("Deleting failed. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  const editorVol = editor ? (volunteers ?? []).find((v) => v.id === editor.volunteerId) ?? null : null;
  // Other volunteers who are staying on the chosen day and can share the shift.
  const teamCandidates =
    editor && editor.mode === "new"
      ? (volunteers ?? [])
          .filter((v) => v.id !== editor.volunteerId && v.checkInDate <= editor.date && v.checkOutDate >= editor.date)
          .sort((a, b) => a.name.localeCompare(b.name))
      : [];

  const outsideStay =
    !!editor &&
    !!editorVol &&
    !!editor.date &&
    (editor.date < editorVol.checkInDate || editor.date > editorVol.checkOutDate);

  const regions = useMemo(() => {
    const map = new Map<string, RouteOpt[]>();
    for (const r of routes) {
      const list = map.get(r.region) ?? [];
      list.push(r);
      map.set(r.region, list);
    }
    return Array.from(map.entries());
  }, [routes]);

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-label="Previous week"
            onClick={() => setStart((s) => addDays(s, -7))}
            className="h-11 w-11 rounded-xl border border-[#E2DFD6] bg-white text-lg"
          >
            ‹
          </button>
          <div className="flex h-11 items-center rounded-xl border border-[#E2DFD6] bg-white px-4 text-sm font-semibold">
            {dayMonth(start)} – {dayMonth(end)}
          </div>
          <button
            type="button"
            aria-label="Next week"
            onClick={() => setStart((s) => addDays(s, 7))}
            className="h-11 w-11 rounded-xl border border-[#E2DFD6] bg-white text-lg"
          >
            ›
          </button>
          <button
            type="button"
            onClick={() => setStart(weekStart(bangkokToday()))}
            className="h-11 rounded-xl border border-[#E2DFD6] bg-white px-3 text-sm font-semibold"
          >
            Today
          </button>
        </div>
        <div className="grow" />
        <button
          type="button"
          onClick={() => openNew()}
          disabled={visible.length === 0}
          className="h-11 rounded-xl bg-[#201E1B] px-5 text-sm font-semibold text-white disabled:opacity-40"
        >
          + Add shift
        </button>
      </div>

      <div className="mb-4 flex flex-wrap gap-4 text-xs text-[#5C5850]">
        <span className="flex items-center gap-2">
          <span className="inline-block h-3.5 w-7 rounded border border-[#6E9A62] bg-[#E3EFE0]" />
          Shift with tour
        </span>
        <span className="flex items-center gap-2">
          <span className="inline-block h-3.5 w-7 rounded border border-dashed border-[#8A857A] bg-white" />
          Shift without tour
        </span>
        <span className="flex items-center gap-2">
          <span className="inline-block h-3.5 w-7 rounded border border-[#E2C27A] bg-[#FFF3D6]" />
          Today
        </span>
        <span className="flex items-center gap-2">
          <span className="inline-block h-3.5 w-7 rounded border border-[#E2DFD6] bg-[#F1EFE8]" />
          Outside stay
        </span>
      </div>

      {loadError && (
        <div role="alert" className="mb-4 rounded-xl border border-red-300 bg-red-50 p-3 text-sm text-red-800">
          {loadError}
        </div>
      )}
      {volunteers === null && !loadError && <p className="text-[#5C5850]">Loading…</p>}
      {volunteers && visible.length === 0 && (
        <div className="rounded-2xl border border-[#E2DFD6] bg-white p-6 text-center text-[#5C5850]">
          No volunteers are staying during this week.
        </div>
      )}

      {visible.length > 0 && (
        <div className="overflow-x-auto rounded-2xl border border-[#E2DFD6] bg-white">
          <div
            className="grid min-w-[900px]"
            style={{ gridTemplateColumns: "150px repeat(7, minmax(110px, 1fr))" }}
          >
            <div className="border-b border-[#E2DFD6] px-3 py-3 text-xs font-semibold text-[#5C5850]">Volunteer</div>
            {days.map((d) => (
              <div
                key={d}
                className={`border-b border-l border-[#E2DFD6] px-3 py-3 ${d === todayStr ? "bg-[#FFF3D6]" : ""}`}
              >
                <div className="text-xs font-semibold text-[#5C5850]">{dowShort(d)}</div>
                <div className="text-base font-semibold">{dayMonth(d)}</div>
              </div>
            ))}

            {visible.map((v) => (
              <VolunteerRow
                key={v.id}
                v={v}
                days={days}
                todayStr={todayStr}
                shifts={shiftsByVol[v.id] ?? []}
                onAdd={(date) => openNew(v.id, date)}
                onEdit={openEdit}
              />
            ))}
          </div>
        </div>
      )}

      <p className="mt-4 text-sm text-[#5C5850]">
        Use “+” in a cell to add a shift for that person and day. Tap a shift to edit or delete it.
      </p>

      {editor && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center"
          onClick={closeEditor}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label={editor.mode === "new" ? "Add shift" : "Edit shift"}
            className="max-h-[92vh] w-full overflow-y-auto rounded-t-2xl bg-white p-5 text-[#201E1B] sm:max-w-md sm:rounded-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-xl font-semibold">
              {editor.mode === "new" ? "Add Shift" : "Edit Shift"}
              {!editor.pick && editor.date ? ` – ${longDayLabel(editor.date)}` : ""}
            </h2>
            {!editor.pick && editorVol && (
              <p className="mb-4 mt-0.5 text-sm text-[#5C5850]">{editorVol.name}</p>
            )}
            {editor.pick && <div className="mb-4" />}

            <div className="space-y-4">
              {editor.pick && (
                <>
                  <div>
                    <label htmlFor="shift-vol" className={fieldLabel}>
                      Volunteer
                    </label>
                    <select
                      id="shift-vol"
                      value={editor.volunteerId}
                      onChange={(e) => patch({ volunteerId: e.target.value, team: [] })}
                      className={fieldInput}
                    >
                      {visible.map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label htmlFor="shift-date" className={fieldLabel}>
                      Date
                    </label>
                    <input
                      id="shift-date"
                      type="date"
                      value={editor.date}
                      onChange={(e) => patch({ date: e.target.value, team: [] })}
                      className={fieldInput}
                    />
                  </div>
                </>
              )}

              {outsideStay && editorVol && (
                <p className="text-sm text-amber-800">
                  This day is outside {editorVol.name}&apos;s stay ({editorVol.checkInDate} → {editorVol.checkOutDate}).
                </p>
              )}

              <div>
                <label htmlFor="shift-tour" className={fieldLabel}>
                  Tour <span className="font-normal text-[#5C5850]">(optional)</span>
                </label>
                <select
                  id="shift-tour"
                  value={editor.tourId}
                  onChange={(e) => chooseTour(e.target.value)}
                  className={fieldInput}
                >
                  <option value="">No tour</option>
                  {regions.map(([region, list]) => (
                    <optgroup key={region} label={region}>
                      {list.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.name}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </div>

              <div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label htmlFor="shift-start" className={fieldLabel}>
                      Start
                    </label>
                    <input
                      id="shift-start"
                      type="time"
                      value={editor.startTime}
                      onChange={(e) => patch({ startTime: e.target.value, timesTouched: true })}
                      className={fieldInput}
                    />
                  </div>
                  <div>
                    <label htmlFor="shift-end" className={fieldLabel}>
                      End
                    </label>
                    <input
                      id="shift-end"
                      type="time"
                      value={editor.endTime}
                      onChange={(e) => patch({ endTime: e.target.value, timesTouched: true })}
                      className={fieldInput}
                    />
                  </div>
                </div>
                <p className="mt-1.5 text-sm text-[#5C5850]">
                  Standard times: Full Day 13:00–21:00, Half Day / Starter 15:00–20:00. You can adjust them.
                </p>
              </div>

              <div>
                <label htmlFor="shift-note" className={fieldLabel}>
                  Notes <span className="font-normal text-[#5C5850]">(optional)</span>
                </label>
                <textarea
                  id="shift-note"
                  rows={3}
                  value={editor.note}
                  onChange={(e) => patch({ note: e.target.value })}
                  className={`${fieldInput} resize-none`}
                />
              </div>

              {editor.mode === "new" && (
                <div>
                  <span className={fieldLabel}>
                    Add team member <span className="font-normal text-[#5C5850]">(optional – same shift)</span>
                  </span>
                  {teamCandidates.length === 0 ? (
                    <p className="text-sm text-[#5C5850]">No other volunteers are staying on this day.</p>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {teamCandidates.map((v) => {
                        const on = editor.team.includes(v.id);
                        return (
                          <button
                            key={v.id}
                            type="button"
                            aria-pressed={on}
                            onClick={() =>
                              patch({ team: on ? editor.team.filter((x) => x !== v.id) : [...editor.team, v.id] })
                            }
                            className={`h-11 rounded-xl border px-3 text-sm ${
                              on
                                ? "border-[#201E1B] bg-[#201E1B] font-semibold text-white"
                                : "border-[#E2DFD6] bg-white text-[#201E1B]"
                            }`}
                          >
                            {v.name}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              {editor.mode === "new" && (
                <div>
                  <span className={fieldLabel}>Also add on (this week)</span>
                  <div className="flex flex-wrap gap-2">
                    {days
                      .filter((d) => d !== editor.date)
                      .map((d) => {
                        const on = editor.repeat.includes(d);
                        return (
                          <button
                            key={d}
                            type="button"
                            aria-pressed={on}
                            onClick={() =>
                              patch({ repeat: on ? editor.repeat.filter((x) => x !== d) : [...editor.repeat, d] })
                            }
                            className={`h-11 min-w-[56px] rounded-xl border px-3 text-sm ${
                              on
                                ? "border-[#201E1B] bg-[#201E1B] font-semibold text-white"
                                : "border-[#E2DFD6] bg-white text-[#201E1B]"
                            }`}
                          >
                            {dowShort(d)}
                          </button>
                        );
                      })}
                  </div>
                </div>
              )}
            </div>

            {formError && (
              <div role="alert" className="mt-4 rounded-xl border border-red-300 bg-red-50 p-3 text-sm text-red-800">
                {formError}
              </div>
            )}

            {confirmDelete ? (
              <div className="mt-5 rounded-xl border border-red-300 bg-red-50 p-3">
                <p className="mb-3 text-sm text-red-900">Delete this shift?</p>
                <div className="flex gap-2">
                  <button type="button" onClick={() => setConfirmDelete(false)} disabled={busy} className={secondaryButton}>
                    Keep
                  </button>
                  <button
                    type="button"
                    onClick={removeShift}
                    disabled={busy}
                    className="rounded-2xl bg-red-700 px-5 py-3 text-base font-semibold text-white disabled:opacity-40"
                  >
                    {busy ? "Deleting…" : "Delete"}
                  </button>
                </div>
              </div>
            ) : (
              <div className="mt-5 flex items-center gap-2">
                {editor.mode === "edit" && (
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(true)}
                    disabled={busy}
                    className="px-2 py-3 text-sm font-semibold text-red-700 disabled:opacity-40"
                  >
                    Delete shift
                  </button>
                )}
                <div className="grow" />
                <button type="button" onClick={closeEditor} disabled={busy} className={secondaryButton}>
                  Cancel
                </button>
                <button type="button" onClick={save} disabled={busy} className={primaryButton}>
                  {busy ? "Saving…" : "Save"}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}

function VolunteerRow({
  v,
  days,
  todayStr,
  shifts,
  onAdd,
  onEdit,
}: {
  v: Vol;
  days: string[];
  todayStr: string;
  shifts: FlyerShift[];
  onAdd: (date: string) => void;
  onEdit: (s: FlyerShift) => void;
}) {
  return (
    <>
      <div className="flex flex-col justify-center border-b border-[#EFEDE7] px-3 py-3">
        <span className="truncate font-semibold">{v.name}</span>
        <span className="text-xs text-[#5C5850]">
          {v.checkInDate ? dayMonth(v.checkInDate) : "?"} → {v.checkOutDate ? dayMonth(v.checkOutDate) : "?"}
        </span>
      </div>
      {days.map((d) => {
        const outside = d < v.checkInDate || d > v.checkOutDate;
        const cell = shifts.filter((s) => s.date === d).sort(compareShifts);
        const bg = d === todayStr ? "bg-[#FFF9EA]" : outside ? "bg-[#F1EFE8]" : "bg-white";
        return (
          <div
            key={d}
            className={`flex min-h-[84px] flex-col gap-1.5 border-b border-l border-[#EFEDE7] p-1.5 ${bg}`}
          >
            {cell.map((s) => {
              const label = tourLabel(s);
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => onEdit(s)}
                  className={`rounded-lg px-2 py-1.5 text-left text-xs ${
                    label
                      ? "border border-[#6E9A62] bg-[#E3EFE0] text-[#1D3A17]"
                      : "border border-dashed border-[#8A857A] bg-white text-[#44403A]"
                  }`}
                >
                  <span className="block font-semibold">
                    {s.startTime}–{s.endTime}
                  </span>
                  <span className="block truncate">{label ?? "No tour"}</span>
                </button>
              );
            })}
            <button
              type="button"
              aria-label={`Add shift for ${v.name} on ${d}`}
              onClick={() => onAdd(d)}
              className="mt-auto h-11 w-full rounded-lg border border-dashed border-[#CFC8B8] text-2xl font-semibold leading-none text-[#5C5850] hover:bg-[#F1EFE8]"
            >
              +
            </button>
          </div>
        );
      })}
    </>
  );
}
