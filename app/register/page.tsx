"use client";

import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { addDoc, collection, doc, getDoc, serverTimestamp } from "firebase/firestore";
import { ref, uploadBytes } from "firebase/storage";
import { db, storage } from "@/lib/firebase";
import { compressImageFile } from "@/lib/image-compression";
import { generateToken } from "@/lib/token";
import LinkedText from "@/components/LinkedText";
import { DEFAULT_REGISTRATION_SETTINGS, parseRegistrationSettings, type RegistrationSettings } from "@/lib/registration-settings";

type UploadState = "idle" | "uploading" | "done" | "error";

const inputClass =
  "block w-full min-w-0 appearance-none rounded-xl border border-[#E2DFD6] bg-white px-4 py-3 text-base text-[#201E1B] min-h-[50px] focus:border-[#201E1B] focus:outline-none";
const labelClass = "mb-1.5 block text-sm font-medium text-[#201E1B]";

// Standard hostel times; volunteers may change them via "Edit".
const DEFAULT_CHECK_IN_TIME = "14:00";
const DEFAULT_CHECK_OUT_TIME = "10:00";

export default function RegisterPage() {
  const [givenName, setGivenName] = useState("");
  const [familyName, setFamilyName] = useState("");
  const [whatsapp, setWhatsapp] = useState("");
  const [checkInDate, setCheckInDate] = useState("");
  const [checkInTime, setCheckInTime] = useState(DEFAULT_CHECK_IN_TIME);
  const [checkOutDate, setCheckOutDate] = useState("");
  const [checkOutTime, setCheckOutTime] = useState(DEFAULT_CHECK_OUT_TIME);
  const [editTimes, setEditTimes] = useState(false);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [termsOpen, setTermsOpen] = useState(false);
  // Editable in the admin (Registrations → Settings); defaults until loaded / if unreadable.
  const [settings, setSettings] = useState<RegistrationSettings>(DEFAULT_REGISTRATION_SETTINGS);

  useEffect(() => {
    let cancelled = false;
    getDoc(doc(db, "flyerSettings", "registration"))
      .then((snap) => {
        if (!cancelled && snap.exists()) setSettings(parseRegistrationSettings(snap.data()));
      })
      .catch((err) => console.error("[register] settings load failed (using defaults):", err));
    return () => {
      cancelled = true;
    };
  }, []);

  const [uploadState, setUploadState] = useState<UploadState>("idle");
  const [passportPhotoPath, setPassportPhotoPath] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const [selfieState, setSelfieState] = useState<UploadState>("idle");
  const [selfiePhotoPath, setSelfiePhotoPath] = useState<string | null>(null);
  const [selfiePreviewUrl, setSelfiePreviewUrl] = useState<string | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submittedName, setSubmittedName] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const galleryInputRef = useRef<HTMLInputElement>(null);
  const selfieInputRef = useRef<HTMLInputElement>(null);
  // One token per form session — retaking the photo overwrites the same
  // path instead of leaving orphaned uploads behind.
  const tokenRef = useRef<string | null>(null);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  useEffect(() => {
    return () => {
      if (selfiePreviewUrl) URL.revokeObjectURL(selfiePreviewUrl);
    };
  }, [selfiePreviewUrl]);

  const datesInvalid = checkInDate !== "" && checkOutDate !== "" && checkOutDate < checkInDate;

  // WhatsApp number incl. country code; just a sanity check (7+ digits), not a format police.
  const whatsappValid = whatsapp.replace(/\D/g, "").length >= 7;

  const canSubmit =
    givenName.trim() !== "" &&
    familyName.trim() !== "" &&
    whatsappValid &&
    checkInDate !== "" &&
    checkOutDate !== "" &&
    !datesInvalid &&
    uploadState === "done" &&
    passportPhotoPath !== null &&
    selfieState === "done" &&
    selfiePhotoPath !== null &&
    termsAccepted &&
    !submitting;

  async function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Reset so selecting the same file again still fires onChange.
    e.target.value = "";
    if (!file) return;

    setError(null);
    setUploadState("uploading");
    setPassportPhotoPath(null);

    try {
      const compressed = await compressImageFile(file);
      tokenRef.current ??= generateToken();
      const path = `flyerPassports/${tokenRef.current}/passport.jpg`;
      await uploadBytes(ref(storage, path), compressed, {
        contentType: compressed.type || "image/jpeg",
      });
      setPreviewUrl(URL.createObjectURL(compressed));
      setPassportPhotoPath(path);
      setUploadState("done");
    } catch (err) {
      console.error("[register] passport upload failed:", err);
      setUploadState("error");
      setError("Passport photo upload failed. Please check your connection and try again.");
    }
  }

  async function handleSelfieChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    setError(null);
    setSelfieState("uploading");
    setSelfiePhotoPath(null);

    try {
      const compressed = await compressImageFile(file);
      tokenRef.current ??= generateToken();
      const path = `flyerPassports/${tokenRef.current}/selfie.jpg`;
      await uploadBytes(ref(storage, path), compressed, {
        contentType: compressed.type || "image/jpeg",
      });
      setSelfiePreviewUrl(URL.createObjectURL(compressed));
      setSelfiePhotoPath(path);
      setSelfieState("done");
    } catch (err) {
      console.error("[register] selfie upload failed:", err);
      setSelfieState("error");
      setError("Selfie upload failed. Please check your connection and try again.");
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit || !passportPhotoPath || !selfiePhotoPath) return;

    setSubmitting(true);
    setError(null);
    const trimmedGiven = givenName.trim();
    const trimmedFamily = familyName.trim();

    try {
      await addDoc(collection(db, "flyerRegistrations"), {
        // `name` is the display name used everywhere in the apps: first name only.
        name: trimmedGiven,
        givenName: trimmedGiven,
        familyName: trimmedFamily,
        whatsapp: whatsapp.trim(),
        checkInDate,
        checkInTime: checkInTime || null,
        checkOutDate,
        checkOutTime: checkOutTime || null,
        passportPhotoPath,
        selfiePhotoPath,
        termsAcceptedAt: serverTimestamp(),
        // The deposit notice sits directly above the terms checkbox, so
        // accepting the terms also acknowledges the deposit.
        depositAcknowledged: true,
        status: "pending",
        submittedAt: serverTimestamp(),
        reviewedAt: null,
        reviewedBy: null,
      });
      setSubmittedName(trimmedGiven);
    } catch (err) {
      console.error("[register] registration write failed:", err);
      setError("Something went wrong while submitting your registration. Please try again — your details are still filled in.");
    } finally {
      setSubmitting(false);
    }
  }

  if (submittedName !== null) {
    return (
      <main className="flex min-h-screen flex-1 items-center justify-center bg-[#EFEDE7] px-4 py-10">
        <div className="w-full max-w-md rounded-2xl border border-[#E2DFD6] bg-white p-6 text-center text-[#201E1B]">
          <div className="mb-3 text-4xl">🎉</div>
          <h1 className="mb-3 text-2xl font-semibold">Thanks, {submittedName}!</h1>
          <p className="whitespace-pre-line text-base leading-relaxed text-[#5C5850]">
            <LinkedText text={settings.confirmationMessage.replace(/\{name\}/g, submittedName)} />
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen flex-1 justify-center bg-[#EFEDE7] px-4 py-8 text-[#201E1B]">
      <div className="w-full max-w-md">
        <h1 className="mb-1 text-2xl font-semibold">Flyer Volunteer Registration</h1>
        <p className="mb-6 text-sm text-[#5C5850]">OXA Flyer Tours — sign up for your stay.</p>

        <form onSubmit={handleSubmit} className="space-y-5">
          <div className="space-y-4 rounded-2xl border border-[#E2DFD6] bg-white p-4">
            <div>
              <label htmlFor="givenName" className={labelClass}>
                Given name
              </label>
              <input
                id="givenName"
                type="text"
                autoComplete="given-name"
                required
                value={givenName}
                onChange={(e) => setGivenName(e.target.value)}
                className={inputClass}
              />
            </div>

            <div>
              <label htmlFor="familyName" className={labelClass}>
                Family name
              </label>
              <input
                id="familyName"
                type="text"
                autoComplete="family-name"
                required
                value={familyName}
                onChange={(e) => setFamilyName(e.target.value)}
                className={inputClass}
              />
            </div>

            {/* Date/time fields stacked vertically on purpose: side-by-side
                native date/time inputs overflow the viewport on iOS. */}
            <div>
              <label htmlFor="checkInDate" className={labelClass}>
                Check-in date
              </label>
              <input
                id="checkInDate"
                type="date"
                required
                value={checkInDate}
                onChange={(e) => setCheckInDate(e.target.value)}
                className={inputClass}
              />
            </div>
            <div>
              <label htmlFor="checkOutDate" className={labelClass}>
                Check-out date
              </label>
              <input
                id="checkOutDate"
                type="date"
                required
                min={checkInDate || undefined}
                value={checkOutDate}
                onChange={(e) => setCheckOutDate(e.target.value)}
                className={inputClass}
              />
              {datesInvalid && (
                <p className="mt-1.5 text-sm text-red-700">Check-out can&apos;t be before check-in.</p>
              )}
            </div>
            {editTimes ? (
              <div className="space-y-4 rounded-xl border border-[#E2DFD6] bg-[#FBF9F4] p-3">
                <div>
                  <label htmlFor="checkInTime" className={labelClass}>
                    Check-in time
                  </label>
                  <input
                    id="checkInTime"
                    type="time"
                    value={checkInTime}
                    onChange={(e) => setCheckInTime(e.target.value)}
                    className={inputClass}
                  />
                </div>
                <div>
                  <label htmlFor="checkOutTime" className={labelClass}>
                    Check-out time
                  </label>
                  <input
                    id="checkOutTime"
                    type="time"
                    value={checkOutTime}
                    onChange={(e) => setCheckOutTime(e.target.value)}
                    className={inputClass}
                  />
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setCheckInTime(DEFAULT_CHECK_IN_TIME);
                    setCheckOutTime(DEFAULT_CHECK_OUT_TIME);
                    setEditTimes(false);
                  }}
                  className="text-sm underline"
                >
                  Reset to standard times
                </button>
              </div>
            ) : (
              <div className="flex items-start justify-between gap-3 rounded-xl border border-[#E2DFD6] bg-[#FBF9F4] p-3">
                <div className="text-sm">
                  <div className="font-medium">
                    Check-in {checkInTime || "—"} · Check-out {checkOutTime || "—"}
                  </div>
                  <div className="mt-0.5 text-[#8A857A]">
                    Standard times: check-in {DEFAULT_CHECK_IN_TIME}, check-out {DEFAULT_CHECK_OUT_TIME}. Only change them if you
                    arrive or leave at a different time.
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setEditTimes(true)}
                  className="shrink-0 rounded-lg border border-[#D6D1C3] bg-white px-3 py-1.5 text-sm font-medium"
                >
                  Edit
                </button>
              </div>
            )}

            <div>
              <label htmlFor="whatsapp" className={labelClass}>
                WhatsApp number
              </label>
              <input
                id="whatsapp"
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                required
                placeholder="+49 151 2345678"
                value={whatsapp}
                onChange={(e) => setWhatsapp(e.target.value)}
                className={inputClass}
              />
              <p className="mt-1 text-sm text-[#8A857A]">Please include your country code. We use it to reach you during your stay.</p>
            </div>
          </div>

          <div className="rounded-2xl border border-[#E2DFD6] bg-white p-4">
            <span className={labelClass}>Passport photo</span>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              onChange={handleFileChange}
              className="hidden"
            />
            {/* No `capture` here: opens the phone's photo library / files instead of the camera. */}
            <input
              ref={galleryInputRef}
              type="file"
              accept="image/*"
              onChange={handleFileChange}
              className="hidden"
            />
            {uploadState === "done" ? (
              <div className="rounded-xl border border-green-600 bg-green-50 p-3 text-green-800">
                <div className="flex items-center gap-3">
                  {previewUrl && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={previewUrl} alt="Passport preview" className="h-14 w-14 rounded-lg object-cover" />
                  )}
                  <div className="flex-1 font-medium">✓ Passport Uploaded</div>
                  <div className="flex flex-col items-end gap-1">
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      className="rounded-lg px-2 py-1 text-sm underline"
                    >
                      Retake
                    </button>
                    <button
                      type="button"
                      onClick={() => galleryInputRef.current?.click()}
                      className="rounded-lg px-2 py-1 text-sm underline"
                    >
                      Upload other
                    </button>
                  </div>
                </div>
              </div>
            ) : uploadState === "uploading" ? (
              <div className="w-full rounded-xl border border-dashed border-[#D6D1C3] bg-[#FBF9F4] px-4 py-4 text-center text-base font-medium opacity-60">
                Uploading…
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="rounded-xl border border-dashed border-[#D6D1C3] bg-[#FBF9F4] px-3 py-4 text-base font-medium"
                >
                  📷 Take photo
                </button>
                <button
                  type="button"
                  onClick={() => galleryInputRef.current?.click()}
                  className="rounded-xl border border-dashed border-[#D6D1C3] bg-[#FBF9F4] px-3 py-4 text-base font-medium"
                >
                  🖼️ Upload from phone
                </button>
              </div>
            )}
          </div>

          <div className="rounded-2xl border border-[#E2DFD6] bg-white p-4">
            <span className={labelClass}>Selfie</span>
            <input
              ref={selfieInputRef}
              type="file"
              accept="image/*"
              capture="user"
              onChange={handleSelfieChange}
              className="hidden"
            />
            {selfieState === "done" ? (
              <div className="rounded-xl border border-green-600 bg-green-50 p-3 text-green-800">
                <div className="flex items-center gap-3">
                  {selfiePreviewUrl && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={selfiePreviewUrl} alt="Selfie preview" className="h-14 w-14 rounded-lg object-cover" />
                  )}
                  <div className="flex-1 font-medium">✓ Selfie Uploaded</div>
                  <button
                    type="button"
                    onClick={() => selfieInputRef.current?.click()}
                    className="rounded-lg px-2 py-1 text-sm underline"
                  >
                    Retake
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                disabled={selfieState === "uploading"}
                onClick={() => selfieInputRef.current?.click()}
                className="w-full rounded-xl border border-dashed border-[#D6D1C3] bg-[#FBF9F4] px-4 py-4 text-base font-medium disabled:opacity-60"
              >
                {selfieState === "uploading" ? "Uploading…" : "🤳 Take a selfie"}
              </button>
            )}
          </div>

          <div className="rounded-2xl border-2 border-[#D6D1C3] bg-[#FBF9F4] p-4 text-base">
            🔒 A refundable deposit of ฿1,000 is required in cash at check-in.
          </div>

          <label className="flex items-start gap-3 text-base">
            <input
              type="checkbox"
              checked={termsAccepted}
              onChange={(e) => setTermsAccepted(e.target.checked)}
              className="mt-1 h-5 w-5 shrink-0 accent-[#201E1B]"
            />
            <span>
              I have read and agree to the{" "}
              <button type="button" onClick={() => setTermsOpen(true)} className="font-medium underline">
                Volunteer Terms &amp; Conditions
              </button>
              .
            </span>
          </label>

          {error && (
            <div role="alert" className="rounded-xl border border-red-300 bg-red-50 p-3 text-sm text-red-800">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={!canSubmit}
            className="w-full rounded-2xl bg-[#201E1B] px-4 py-4 text-base font-semibold text-white disabled:opacity-40"
          >
            {submitting ? "Submitting…" : "Submit registration"}
          </button>
        </form>
      </div>

      {termsOpen && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center"
          onClick={() => setTermsOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="terms-title"
            onClick={(e) => e.stopPropagation()}
            className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-t-2xl bg-white p-6 text-[#201E1B] sm:rounded-2xl"
          >
            <h2 id="terms-title" className="mb-3 text-lg font-semibold">
              Volunteer Terms &amp; Conditions
            </h2>
            <p className="mb-6 whitespace-pre-line text-base leading-relaxed text-[#5C5850]"><LinkedText text={settings.termsText} /></p>
            <button
              type="button"
              onClick={() => setTermsOpen(false)}
              className="w-full rounded-2xl bg-[#201E1B] px-4 py-3 text-base font-semibold text-white"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
