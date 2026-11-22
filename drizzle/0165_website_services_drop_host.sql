-- An app's addresses are ee's routes (plan/domains-one-claim.md D2): the copy
-- of the main address in website_services.host is dropped, and with it the
-- check that a web service keeps one (website_services_web_has_host). Every
-- reader now takes the app's routes from ee's status; what a hostname shows
-- is the domains module's rule ($lib/server/domains/targets).

ALTER TABLE "website_services" DROP CONSTRAINT IF EXISTS "website_services_web_has_host";
ALTER TABLE "website_services" DROP COLUMN IF EXISTS "host";
