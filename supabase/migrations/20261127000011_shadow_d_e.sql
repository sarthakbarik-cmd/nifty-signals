-- Owner's choice (27 Nov 2026): main plan B; background plans only D and E (A, C, F, G dropped; more can be added later).
update public.app_config set value = value || jsonb_build_object('shadow_variants', jsonb_build_array('D','E')), updated_at = now() where key = 'settings';
delete from public.shadow_trades where variant not in ('D','E');
