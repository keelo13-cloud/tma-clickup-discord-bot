require('dotenv').config();
const express = require('express');
const { verifyKeyMiddleware, InteractionType, InteractionResponseType } = require('discord-interactions');
const axios = require('axios');
const app = express();
const PORT = process.env.PORT || 3000;
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DISCORD_APP_ID = process.env.DISCORD_APP_ID;
const DISCORD_PUBLIC_KEY = process.env.DISCORD_PUBLIC_KEY;
const CLICKUP_API_KEY = process.env.CLICKUP_API_KEY;
const CLICKUP_DONE_STATUS = process.env.CLICKUP_DONE_STATUS || 'done';
const CLICKUP_IN_REVIEW_STATUS = process.env.CLICKUP_IN_REVIEW_STATUS || 'in review';

async function updateClickUpStatus(taskId, status) {
  await axios.put(
    `https://api.clickup.com/api/v2/task/${taskId}`,
    { status },
    {
      headers: {
        Authorization: CLICKUP_API_KEY,
        'Content-Type': 'application/json'
      }
    }
  );
}

async function getClickUpTask(taskId) {
  const res = await axios.get(
    `https://api.clickup.com/api/v2/task/${taskId}`,
    { headers: { Authorization: CLICKUP_API_KEY } }
  );
  return res.data;
}

async function editInteractionMessage(token, content, embeds = [], components = []) {
  await axios.patch(
    `https://discord.com/api/v10/webhooks/${DISCORD_APP_ID}/${token}/messages/@original`,
    { content, embeds, components },
    {
      headers: {
        Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
        'Content-Type': 'application/json'
      }
    }
  );
}

app.post('/interactions', verifyKeyMiddleware(DISCORD_PUBLIC_KEY), async (req, res) => {
  const interaction = req.body;

  // ── PING ──────────────────────────────────────────────────────────────────
  if (interaction.type === InteractionType.PING) {
    return res.json({ type: InteractionResponseType.PONG });
  }

  // ── MODAL SUBMIT ──────────────────────────────────────────────────────────
  if (interaction.type === InteractionType.APPLICATION_MODAL) {
    const customId = interaction.data.custom_id;

    if (customId.startsWith('reject_feedback::')) {
      const [, driveFileId, channelId, messageId] = customId.split('::');
      const feedback = interaction.data.components[0].components[0].value;
      const originalDraft = interaction.data.components[1]?.components[0]?.value || '';
      const username = interaction.member?.user?.username || interaction.user?.username;
      const token = interaction.token;

      // Acknowledge modal submission
      res.json({ type: InteractionResponseType.DEFERRED_UPDATE_MESSAGE });

      const N8N_APPROVAL_WEBHOOK = process.env.N8N_APPROVAL_WEBHOOK;

      // Update the original draft message to show regenerating state
      await editInteractionMessage(
        token,
        `🔄 **Regenerating draft with feedback from ${username}...**\n\n> "${feedback}"`,
        [],
        []
      ).catch(err => console.error('Failed to update message after modal submit:', err.message));

      // Forward to n8n
      if (N8N_APPROVAL_WEBHOOK) {
        await axios.post(N8N_APPROVAL_WEBHOOK, {
          action: 'revise',
          driveFileId,
          feedback,
          originalDraft,
          rejectedBy: username,
          channelId,
          messageId,
          timestamp: new Date().toISOString(),
        }).catch(err => console.error('Failed to forward revision to n8n:', err.message));
      }

      return;
    }
  }

  // ── BUTTON / MESSAGE COMPONENT ────────────────────────────────────────────
  if (interaction.type === InteractionType.MESSAGE_COMPONENT) {
    const customId = interaction.data.custom_id;
    const token = interaction.token;

    // ── Twitter draft approval buttons ──────────────────────────────────────
    if (customId.startsWith('approve_draft') || customId.startsWith('reject_draft')) {
      const N8N_APPROVAL_WEBHOOK = process.env.N8N_APPROVAL_WEBHOOK;
      const [action, tweetId, driveFileId] = customId.split('::');
      const username = interaction.member?.user?.username || interaction.user?.username;

      if (action === 'approve_draft') {
        // Acknowledge immediately
        res.json({ type: InteractionResponseType.DEFERRED_UPDATE_MESSAGE });

        const draft = interaction.message.embeds?.[0]?.description?.split('---\n\n')[1] || '';
        console.log('[approve] Forwarding to n8n, draft length:', draft.length);

        if (N8N_APPROVAL_WEBHOOK) {
          await axios.post(N8N_APPROVAL_WEBHOOK, {
            action: 'approve',
            tweetId,
            driveFileId,
            draft,
            approvedBy: username,
            timestamp: new Date().toISOString(),
          }).catch(err => console.error('Failed to forward approval:', err.message));
        } else {
          console.warn('[approve] N8N_APPROVAL_WEBHOOK not set');
        }

        await editInteractionMessage(
          token,
          `✅ **Post queued in Hypefury!** It will go live on @MaddenAcademy_ according to the schedule.\n\n_Approved by ${username}_`,
          [],
          []
        ).catch(err => console.error('Failed to update message after approve:', err.message));

      } else if (action === 'reject_draft') {
        const originalDraft = interaction.message.embeds?.[0]?.description?.split('---\n\n')[1] || '';
        const channelId = interaction.channel_id;
        const messageId = interaction.message.id;

        // Show modal popup to collect feedback
        return res.json({
          type: 9, // MODAL response type
          data: {
            custom_id: `reject_feedback::${driveFileId}::${channelId}::${messageId}`,
            title: 'Revise This Draft',
            components: [
              {
                type: 1, // Action Row
                components: [
                  {
                    type: 4, // Text Input
                    custom_id: 'feedback',
                    label: 'What needs to be added or revised?',
                    style: 2, // Paragraph (multi-line)
                    placeholder: 'e.g. "Add a title", "Revise section 3", "Make it shorter"',
                    required: true,
                    max_length: 1000,
                  }
                ]
              },
              {
                type: 1, // Action Row
                components: [
                  {
                    type: 4, // Text Input
                    custom_id: 'original_draft',
                    label: 'Original Draft (do not edit)',
                    style: 2, // Paragraph
                    value: originalDraft.substring(0, 4000),
                    required: false,
                  }
                ]
              }
            ]
          }
        });
      }

      return;
    }

    // ── Existing ClickUp logic ───────────────────────────────────────────────
    const [action, taskId] = customId.split('_TASK_');
    if (!taskId) {
      return res.json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: '❌ Invalid button action.', flags: 64 }
      });
    }

    res.json({ type: InteractionResponseType.DEFERRED_UPDATE_MESSAGE });
    try {
      const task = await getClickUpTask(taskId);
      const taskName = task.name;
      if (action === 'done') {
        await updateClickUpStatus(taskId, CLICKUP_DONE_STATUS);
        await editInteractionMessage(token, `✅ **Marked as Done:** ${taskName}\n_ClickUp has been updated._`);
      } else if (action === 'review') {
        await updateClickUpStatus(taskId, CLICKUP_IN_REVIEW_STATUS);
        await editInteractionMessage(token, `🔍 **Sent for Review:** ${taskName}\n_ClickUp has been updated._`);
      }
    } catch (err) {
      console.error('Error handling interaction:', err?.response?.data || err.message);
      await editInteractionMessage(token, `❌ Failed to update task. Please check ClickUp manually.`).catch(() => {});
    }
    return;
  }

  return res.status(400).json({ error: 'Unknown interaction type' });
});

app.get('/', (req, res) => res.send('TMA Discord Bot is running ✅'));
app.listen(PORT, () => console.log(`Bot running on port ${PORT}`));
