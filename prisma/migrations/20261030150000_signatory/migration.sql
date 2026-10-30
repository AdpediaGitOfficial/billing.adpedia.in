-- docs/82 · who actually signs
--
-- The template printed a generic "Authorised Signatory" above the rule, and `Company` carried
-- only a signature IMAGE. A document that names the person signing it — and what they are in
-- the entity, which differs between a company's director and a firm's managing partner — is
-- what a recipient and an assessment both read.
ALTER TABLE "Company" ADD COLUMN "signatoryName" TEXT;
ALTER TABLE "Company" ADD COLUMN "signatoryDesignation" TEXT;
