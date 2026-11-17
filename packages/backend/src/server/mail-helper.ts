import nodemailer from 'nodemailer';

export interface SendMailOptions {
  to: string;
  subject: string;
  html?: string;
  text?: string;
  from?: string;
}

export interface SendMailResult {
  success: boolean;
  skipped?: boolean;
  error?: string;
}

/**
 * Sends an email via SMTP using APP_MAIL_* environment variables.
 * Gracefully skips when SMTP credentials are not configured.
 */
export async function sendEnterpriseMail(options: SendMailOptions): Promise<SendMailResult> {
  const host = process.env.APP_MAIL_HOST?.trim();
  const port = parseInt(process.env.APP_MAIL_PORT?.trim() || '587', 10);
  const username = process.env.APP_MAIL_USERNAME?.trim();
  const password = process.env.APP_MAIL_PASSWORD?.trim();
  const encryption = (process.env.APP_MAIL_ENCRYPTION || '').trim().toLowerCase();
  const fromName = process.env.APP_MAIL_FROM_NAME?.trim() || 'Employee Agents';

  if (!host || !username || !password) {
    console.warn(
      `[enterprise-mail] SMTP configuration incomplete (host=${host || 'missing'}, username=${username || 'missing'}). Skipping email dispatch.`
    );
    return { success: false, skipped: true, error: 'SMTP configuration incomplete.' };
  }

  try {
    const secure = port === 465 || encryption === 'ssl';
    const transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: {
        user: username,
        pass: password
      },
      tls: {
        rejectUnauthorized: false
      }
    });

    await transporter.sendMail({
      from: options.from || `"${fromName}" <${username}>`,
      to: options.to,
      subject: options.subject,
      text: options.text || '',
      html: options.html || ''
    });

    console.info(`[enterprise-mail] Invitation email sent to ${options.to}`);
    return { success: true };
  } catch (err) {
    console.error('[enterprise-mail] Failed to send email:', err);
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to send email.'
    };
  }
}

export async function sendWorkspaceInviteEmail(params: {
  to: string;
  workspaceName: string;
  role: string;
  inviteUrl: string;
  invitedByEmail: string;
}): Promise<SendMailResult> {
  const safeWs = params.workspaceName.replace(/[<>&"]/g, '');
  const safeInviter = params.invitedByEmail.replace(/[<>&"]/g, '');
  const subject = `You're invited to join ${safeWs} on Employee Agents`;
  const text = [
    `${safeInviter} invited you to join "${params.workspaceName}" as ${params.role} on Employee Agents.`,
    '',
    `Open this link to accept your invitation:`,
    params.inviteUrl
  ].join('\n');

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px; background: #111b21; color: #e9edef; border-radius: 12px; border: 1px solid #2a3942;">
      <h2 style="margin: 0 0 12px; font-size: 18px; color: #e9edef;">Join ${safeWs} on Employee Agents</h2>
      <p style="margin: 0 0 16px; font-size: 14px; color: #aebac1; line-height: 1.5;">
        <strong>${safeInviter}</strong> invited you to collaborate in <strong>${safeWs}</strong> as <strong>${params.role}</strong>.
      </p>
      <a href="${params.inviteUrl}" style="display: inline-block; padding: 10px 18px; background: #00a884; color: #111b21; font-weight: 600; font-size: 14px; text-decoration: none; border-radius: 8px;">
        Accept Invitation
      </a>
      <p style="margin: 18px 0 0; font-size: 12px; color: #8696a0; word-break: break-all;">
        Or open this link: ${params.inviteUrl}
      </p>
    </div>
  `;

  return sendEnterpriseMail({
    to: params.to,
    subject,
    text,
    html
  });
}
