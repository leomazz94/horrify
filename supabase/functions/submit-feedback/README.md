# Private testing feedback

The frontend submits authenticated feedback to this Edge Function. The function validates the session with Auth getUser, derives the sender identity from that session, and stores the message in private tables. Anonymous and unconfirmed accounts are rejected. There are no public read policies. A database trigger limits each user to three new messages per ten minutes; request IDs prevent duplicates during retries.

Deployment: submit-feedback, verify_jwt=false. Authentication is explicitly checked inside the handler, including when publishable API keys are used. Apply feedback.sql once through a migration. Configure the recipient in feedback_delivery_config using an administrator connection; never expose this table to the browser.

Secrets: RESEND_API_KEY is required for email notifications. FEEDBACK_FROM_EMAIL optionally specifies a sender on a verified Resend domain, for example HORRIFY <feedback@updates.horrify.it>. The default onboarding@resend.dev sender is suitable only for Resend testing to the account owner's address. No API key or recipient address belongs in this repository.

Messages are retained even if delivery fails or the key is absent. email_status records pending, sent, or failed. Pending and failed deliveries require administrator follow-up; enabling a key does not automatically send older messages. The confirmation shown to users acknowledges private receipt rather than claiming email delivery. Notifications use plain text and the authenticated user's address as reply_to.
