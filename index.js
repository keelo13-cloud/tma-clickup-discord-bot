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

  if (interaction.type === InteractionType.PING) {
    return res.json({ type: InteractionResponseType.PONG });
  }

  if (interaction.type === InteractionType.MESSAGE_COMPONENT) {
    const customId = interaction.data.custom_id;
    const token = interaction.token;

    // ── Twitter draft approval buttons ──────────────────────────────────────
    if (customId.startsWith('approve_draft') || customId.startsWith('reject_draft')) {
      const N8N_APPROVAL_WEBHOOK = process.env.N8N_APPROVAL_WEBHOOK;
      const [action, tweetId, driveFileId] = customId.split('::');
      const username = interaction.member?.user?.username || interaction.user?.username;

      // Acknowledge immediately
      res.json({ type: InteractionResponseType.DEFERRED_UPDATE_MESSAGE });

      if (action === 'approve_draft') {
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
        const originalDraft = interaction.message.embeds?.[0]?.description || '';
        const originalFileName = interaction.message.embeds?.[0]?.description?.match(/`(.+?)`/)?.[1] || '';
        console.log('[reject] Forwarding to n8n');

        if (N8N_APPROVAL_WEBHOOK) {
          await axios.post(N8N_APPROVAL_WEBHOOK, {
            action: 'revise',
            driveFileId,
            originalDraft,
            originalFileName,
            rejectedBy: username,
            channelId: interaction.channel_id,
            messageId: interaction.message.id,
            timestamp: new Date().toISOString(),
          }).catch(err => console.error('Failed to forward rejection:', err.message));
        } else {
          console.warn('[reject] N8N_APPROVAL_WEBHOOK not set');
        }

        await editInteractionMessage(
          token,
          `🔄 **Revision requested by ${username}.** Regenerating draft with feedback...`,
          [],
          []
        ).catch(err => console.error('Failed to update message after reject:', err.message));
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
