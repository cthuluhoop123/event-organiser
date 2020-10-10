const config = require('./config.js');
const utils = require('./utils.js');

const redis = require('./redis.js');

const Discord = require('discord.js');
const { MessageEmbed } = require('discord.js');

const client = new Discord.Client();

const awaitingMessage = new Set();

client.on('ready', async () => {
    console.log(`Logged in as ${client.user.tag}!`);
    console.log(await client.generateInvite(8));
});

client.on('raw', async event => {
    if (!config.rawEvents[event.t]) return;

    const { d: data } = event;
    const user = client.users.cache.get(data.user_id);
    const channel = client.channels.cache.get(data.channel_id) || await user.createDM();

    if (channel.messages.cache.has(data.message_id)) return;

    const message = await channel.messages.fetch(data.message_id);

    const emojiKey = data.emoji.id || data.emoji.name;
    const reaction = message.reactions.cache.get(emojiKey);

    client.emit(config.rawEvents[event.t], reaction, user);
});

client.on('message', async message => {
    if (message.author.bot
        || !message.guild
        || !message.content.startsWith(config.prefix)
        || awaitingMessage.has(message.author.id))
        return;

    const args = message.content.split(' ');
    const command = args.shift().toLowerCase().slice(config.prefix.length);

    if (command === 'newevent') {
        if (!args[0]) {
            message.reply('Please specify a valid name for this event.');
            return;
        }

        const eventName = args.join(' ').trim();

        const conflictingEvent = await utils.getEvent({ name: eventName, guildId: message.guild.id });
        if (conflictingEvent) {
            message.reply('An event with that name is already scheduled.');
            return;
        }

        try {
            awaitingMessage.add(message.author.id);

            await message.reply({
                embed: new MessageEmbed()
                    .setDescription('At what time would this event be occuring?' +
                        ' *Please format as DD/MM/YYYY HH:MM (24 hour time)*')
                    .addField('Example', '25/12/2020 17:00')
                    .setColor(config.colors.example)
            })
                .catch(err => { });

            const filter = msg => msg.author.id === message.author.id
                && msg.content.match(/^\d{1,2}\/\d{1,2}\/\d{4}\s\d{1,2}:\d{2}$/);

            const timeReply = await message.channel.awaitMessages(filter, {
                max: 1,
                time: config.botMessageTimeout,
                errors: ['time']
            });
            const timeMsg = timeReply.first().content;

            const [dateString, time] = timeMsg.split(' ');
            const [day, month, year] = dateString.split('/');
            const [hour, minute] = time.split(':');
            const date = new Date();
            date.setFullYear(Number(year), Number(month) - 1, Number(day));
            date.setHours(hour, minute, 0, 0);
            await message.reply({
                embed: new MessageEmbed()
                    .setDescription('Please give a short description of the event.')
                    .addField('Example', 'We\'ll be singing Christmas carols or something.')
                    .setColor(config.colors.example)
            })
                .catch(err => { });

            const descriptionReply = await message.channel.awaitMessages(m => m.author.id === message.author.id, {
                max: 1,
                time: config.botMessageTimeout,
                errors: ['time']
            });

            awaitingMessage.delete(message.author.id);

            const statusMsg = await message.reply('*Creating event...*');
            const event = await utils.createEvent(message.guild, eventName, descriptionReply.first().content, date);

            await createEventRoles(message.guild, event).catch(err => console.error('Could not create event role', eventName, err));
            await createGuildEvent(message.guild, event, descriptionReply.first().content, date);

            statusMsg.edit(`${message.author}, New event ***${event.name}*** created!`).catch(err => { });
        } catch (err) {
            awaitingMessage.delete(message.author.id);
            utils.deleteEvent({ guildId: message.guild.id, name: eventName }).catch(err => { });
            if (err instanceof Discord.Collection) {
                message.reply('event creation expired after inactivity.').catch(err => { });
                return;
            }
            if (err.name === 'SequelizeUniqueConstraintError') {
                message.reply('An event with that name is already scheduled.');
                return;
            }
            message.reply('An error occured: ' + err.message);
            console.error(err);
        }
    }

    if (command === 'setutc') {
        try {
            const newUTC = Number(args[0]);
            await utils.setGuildUTCTimezone(message.guild, newUTC);
            message.reply(`This guild is now in UTC${newUTC > 0 ? '+' : ''} ${newUTC} `)
        } catch (err) {
            message.reply('Could not update timezone: ' + err.message);
            console.error(err);
        }
    }
});

client.on('messageReactionAdd', async (reaction, user) => {
    if (user.bot || !reaction.message.guild) return;

    const correspondingEvent = await redis.getAsync(reaction.message.id);
    if (correspondingEvent === null) return;

    const event = await utils.getEvent({ id: correspondingEvent });

    if (!event) {
        await redis.delAsync(reaction.message.id);
        return;
    }
    if (event.date > Date.now()) {
        if (reaction.emoji.name === 'bin') {
            await event.removeParticipant(user.id);
        } else if (config.emojiDecision[reaction.emoji.name]) {
            await event.addParticipant(user.id, config.emojiDecision[reaction.emoji.name]);
            if (event.roleId) {
                try {
                    const reactionMember = await reaction.message.guild.members.fetch(user.id);
                    if (reaction.emoji.name === 'tick')
                        await reactionMember.roles.add(event.roleId, 'Reacted to event.')
                            .catch(err => console.error('Could not add event role to user', err));
                    else
                        await reactionMember.roles.remove(event.roleId, 'Reacted to event.')
                            .catch(err => console.error('Could not add event role to user', err));
                } catch (err) {
                    if (err.httpStatus !== 404)
                        console.error(`Error fetching member: `, err);
                }
            }
        }

        await event.reload();

        reaction.message.edit({ embed: await utils.createEventPost(reaction.message.guild, event) }).catch(err => {
            console.error('Could not edit embed after updating member decision', err);
        });
    }

    reaction.users.remove(user.id).catch(err => { });
});

client.on('error', err => { });

client.login(process.env.DISCORD_TOKEN);

async function createGuildEvent(guild, event) {
    let { allEvents } = utils.getEventsChannels(guild);
    if (!allEvents)
        allEvents = (await utils.createEventChannels(guild)).allEvents;

    const question = utils.findEmojiByName(client, 'question');
    const cross = utils.findEmojiByName(client, 'cross');
    const tick = utils.findEmojiByName(client, 'tick');
    const bin = utils.findEmojiByName(client, 'bin');

    const eventPost = await allEvents.send({ embed: await utils.createEventPost(guild, event) });

    await utils.storeEventPost(eventPost, event);

    utils.longTimeout(() => {
        utils.expireEvent(guild, event.id).catch(err => console.error(`Could not expire event ${event.id} `, err));
    }, event.date - Date.now() + 1000 * 60 * 60 * 24);

    await eventPost.react(tick);
    await eventPost.react(cross);
    await eventPost.react(question);
    await eventPost.react(bin);
}

async function createEventRoles(guild, event) {
    const role = await guild.roles.create({
        data: {
            name: utils.truncate(event.name),
            mentionable: true
        },
        reason: `For event: ${event.name} `
    });
    event.roleId = role.id;
    await event.save();
    return;
}

module.exports = client;