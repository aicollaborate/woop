-- Minimize device registration to a random app-install ID plus platform/version.
-- Remove stable machine identifiers and ancillary fingerprinting fields,
-- including historical values already stored in the table.

drop index if exists public.device_registrations_machine_id_idx;

alter table public.device_registrations
  drop column if exists machine_id,
  drop column if exists machine_fingerprint,
  drop column if exists hostname_hash,
  drop column if exists locale,
  drop column if exists timezone,
  drop column if exists app_user_agent,
  drop column if exists raw_meta;
