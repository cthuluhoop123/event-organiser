const config = require('./config.js');
const database = require('./database.js');
const { Permissions, MessageEmbed } = require('discord.js');

const redis = require('./redis.js');

module.exports = {
    getGuild(guildId) {
        return database.Guilds.findCreateFind({
            where: {
                id: guildId
            }
        });
    },
    getAllEvents(where) {
        return database.Events.findAll({
            where,
            include: 'participants'
        });
    },
    getEvent(query) {
        return database.Events.findOne({
            where: query,
            include: 'participants'
        });
    },
    deleteEvent(query) {
        return database.Events.destroy({
            where: query
        });
    },
    async expireEvent(guild, eventId) {
        const event = await this.getEvent({ id: eventId });
        if (!event) return;

        event.expired = true;
        await event.save();

        if (!guild) return;

        try {
            const eventRole = await guild.roles.fetch(event.roleId);
            await eventRole.delete('Event expired.');
        } catch (err) { }

        const { allEvents } = this.getEventsChannels(guild);
        if (!allEvents) return;

        const post = await event.getEventPost();

        const postedEvent = await allEvents.messages.fetch(post.id).catch(err => null);
        if (!postedEvent) return;

        postedEvent.edit({ embed: await this.createEventPost(guild, event) });
    },
    async createEvent(guild, name, description, unparsedDate) {
        const [dbGuild] = await this.getGuild(guild.id);
        const date = this.localToServerTime(unparsedDate, dbGuild.utc_offset);
        const event = await database.Events.create({
            name: name.trim(),
            description: description.trim(),
            date,
        });
        await event.setGuild(dbGuild);
        await event.setDataValue('participants', await event.getParticipants());
        return event;
    },
    async editEvent(event, field, data) {
        if (field === 'date') {
            const guild = await event.getGuild();
            const date = this.dateFromString(data);
            event.date = this.localToServerTime(date, guild.utc_offset);
            return event.save();
        }
        event[field] = data;
        return event.save();
    },
    async createEventChannels(guild) {
        const eventsCategory = await guild.channels.create('Organized Events', {
            type: 'category',
            reason: 'Event organiser bot.'
        });
        const allEvents = await guild.channels.create('All Events', {
            type: 'text',
            parent: eventsCategory,
            topic: 'All events!',
            permissionOverwrites: [{
                id: guild.id,
                deny: [Permissions.FLAGS.SEND_MESSAGES],
                type: 'role'
            }],
            reason: 'Event organiser bot.'
        });
        const eventTalk = await guild.channels.create('event-talk', {
            type: 'text',
            parent: eventsCategory,
            topic: 'Discuss and talk about upcoming/past events.',
            reason: 'Event organiser bot.'
        });

        return {
            allEvents,
            eventTalk
        };
    },
    setGuildUTCTimezone(guild, utc) {
        return database.Guilds.update({ utc_offset: utc }, {
            where: {
                id: guild.id
            }
        });
    },
    async createEventPost(guild, event) {
        const [dbGuild] = await this.getGuild(guild.id);

        const question = this.findEmojiByName(guild.client, 'question');
        const cross = this.findEmojiByName(guild.client, 'cross');
        const tick = this.findEmojiByName(guild.client, 'tick');

        const going = await this.getNicknamesByDecision(guild, event, 'Going');
        const notGoing = await this.getNicknamesByDecision(guild, event, 'Not Going');
        const unsure = await this.getNicknamesByDecision(guild, event, 'Unsure');
        
        let eventDate = this.serverToLocalTime(event.date, dbGuild.utc_offset).toUTCString().split(':');
        eventDate.pop();
        eventDate = eventDate.join(':');
        
        return new MessageEmbed()
            .setColor(event.expired ? config.colors.expired : config.colors.active)
            .setTitle(`[${event.id}] ${event.name}`)
            .setDescription(event.description)
            .addField('Time', eventDate)
            .addField(`${tick} Going (${going.length})`, going.join('\n') || '-', true)
            .addField(`${cross} Not Going (${notGoing.length})`, notGoing.join('\n') || '-', true)
            .addField(`${question} Unsure (${unsure.length})`, unsure.join('\n') || '-', true)
            .setTimestamp(event.createdAt);
    },
    localToServerTime(date, utc) {
        const serverTime = new Date(date.getTime());
        serverTime.setHours(serverTime.getHours() - utc - serverTime.getTimezoneOffset() / 60);
        return serverTime;
    },
    serverToLocalTime(date, utc) {
        const localised = new Date(date.getTime());
        localised.setHours(localised.getHours() + localised.getTimezoneOffset() / 60 + utc);
        return localised;
    },
    async storeEventPost(message, event) {
        const post = await database.EventPosts.create({
            id: message.id,
            eventId: event.id
        });
        await redis.setAsync(message.id, event.id);
        return post;
    },
    findEmojiByName(client, name) {
        return client.emojis.cache.find(emoji => emoji.name === name);
    },
    filterParticipants(event, status) {
        return event.getDataValue('participants').filter(participant => participant.eventParticipants.decision === status);
    },
    getNicknamesByDecision(guild, event, decision) {
        const participants = event.getDataValue('participants').filter(participant => participant.eventParticipants.decision === decision);
        return this.getNicknameFromParticipants(guild, participants);
    },
    async getNicknameFromParticipants(guild, participants) {
        const nicknames = await Promise.all(
            participants.map(p => {
                return this.getNicknameFromId(guild, p.id).catch(err => null);
            })
        );
        return nicknames.filter(Boolean);
    },
    async getNicknameFromId(guild, id) {
        try {
            const member = await guild.members.fetch(id);
            return member.displayName;
        } catch (err) {
            if (err.httpStatus === 404)
                return null;
            throw err;
        }
    },
    getEventsChannels(guild) {
        return {
            allEvents: this.getOrganizedEventsChannel(guild, 'all-events'),
            eventTalk: this.getOrganizedEventsChannel(guild, 'event-talk')
        };
    },
    getOrganizedEventsChannel(guild, name) {
        return guild.channels.cache.find(channel => {
            return channel.parent
                && channel.parent.name === 'Organized Events'
                && channel.name === name
        });
    },
    truncate(string, length = 30) {
        if (string.length <= length) return string;

        return string.slice(0, length - 3) + '...';
    },
    validDate(string) {
        return !!string.match(/^\d{1,2}\/\d{1,2}\/\d{4}\s\d{1,2}:\d{2}$/);
    },
    dateFromString(timeMsg) {
        const [dateString, time] = timeMsg.split(' ');
        const [day, month, year] = dateString.split('/');
        const [hour, minute] = time.split(':');
        const date = new Date();
        date.setFullYear(Number(year), Number(month) - 1, Number(day));
        date.setHours(hour, minute, 0, 0);

        return date;
    }
}
