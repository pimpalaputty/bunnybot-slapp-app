'use strict'

const express = require('express')
const Slapp = require('slapp')
const ConvoStore = require('slapp-convo-beepboop')
const Context = require('slapp-context-beepboop')

const apiai = require('apiai')
const apiAiAccessToken = process.env.APIAI_ACCESS_TOKEN
const apiaiOptions = {}
const apiAiService = apiai(apiAiAccessToken, apiaiOptions)

const uuid = require('node-uuid')

const Entities = require('html-entities').XmlEntities
const decoder = new Entities()

const sessionIds = new Map()

var IFTTT_package = require('node-ifttt-maker'),
    IFTTT = new IFTTT_package(process.env.IFTTT_MAKER_TOKEN);

var admin = require("firebase-admin");
admin.initializeApp({
    credential: admin.credential.cert({
        projectId: "bunnybot-aec3c",
        clientEmail: "firebase-adminsdk-5ct8p@bunnybot-aec3c.iam.gserviceaccount.com",
        privateKey: process.env.FIB_PRIVATEKEY
    }),
    databaseURL: "https://bunnybot-aec3c.firebaseio.com"
});
var db = admin.database()

// use `PORT` env var on Beep Boop - default to 3000 locally
var port = process.env.PORT || 3000

var slapp = Slapp({
    // Beep Boop sets the SLACK_VERIFY_TOKEN env var
    verify_token: process.env.SLACK_VERIFY_TOKEN,
    convo_store: ConvoStore(),
    context: Context()
})

function isDefined(obj) {
    if (typeof obj == 'undefined') {
        return false
    }

    if (!obj) {
        return false
    }

    return obj != null
}

var HELP_TEXT_COMMAND = `
I will respond to the following Slack commands:
\`/bunny help\` - to see this message.
\`/bunny bug [project] [short description]\` - to create a bug ticket for the given project.
\`/bunny feature [project] [short description]\` - to create a feature ticket for the given project.
The following projects are connected today:
\`mobile2020\`,  \`online2020\`, \`wallet\`, \`maneko\`
`

//*********************************************
// Setup different handlers for messages
//*********************************************

var isValidProjectId = function(pid) {
    console.log("pid", pid);
    return ["maneko", "mobile2020", "online2020", "wallet", "micraft", "essencex"].indexOf(pid) !== -1;
}

slapp.command('/bunny', '(\\w+)\\s?([\\w]+)(.*)', (msg, value, type, projectId, description) => {

    var help = function(text) {
        msg.say({
            text: text ? text + '\n' + HELP_TEXT_COMMAND : HELP_TEXT_COMMAND
        })
    }

    if (!isDefined(value) || !value || (type && ['bug', 'feature'].indexOf(type))) {
        help()
    } else if (!(type && projectId && description)) {
        help('Something is missing!')
    } else if (!isValidProjectId(projectId)) {
        msg.say({
            text: 'Invalid project identifier!'
        })
    } else {
        // everything is okey
        IFTTT.request({
            event: 'bug_' + projectId + '_trello',
            method: 'POST',
            params: {
                'value1': description,
                'value2': msg.body.user_name || '',
                'value3': ''
            }
        }, function(err) {
            if (err) {
                console.log('IFTTT error:', err);
            } else {
                console.log('IFTTT post OK');
            }
        })

        msg.respond(msg.body.response_url, 'Done!')
    }
})

slapp.message('.*', ['direct_message', 'direct_mention', 'mention', 'ambient'], (msg, text) => {
    try {
        let requestText = decoder.decode(text)
        requestText = requestText.replace("’", "'")

        let channel = msg.body.event.channel
        let botId = msg.meta.bot_user_id
        let userId = msg.body.event.user

        if (requestText.indexOf(botId) > -1) {
            requestText = requestText.replace(botId, '')
        }

        if (!sessionIds.has(channel)) {
            sessionIds.set(channel, uuid.v1())
        }

        console.log('Start request:', requestText)
        let request = apiAiService.textRequest(requestText, {
            sessionId: sessionIds.get(channel),
            contexts: [{
                name: "generic",
                parameters: {
                    slack_user_id: userId,
                    slack_channel: channel
                }
            }]
        })
        request.on('response', (response) => {
            console.log(response)

            if (isDefined(response.result)) {
                let responseText = response.result.fulfillment.speech
                let responseData = response.result.fulfillment.data
                let action = response.result.action

                if (isDefined(responseData) && isDefined(responseData.slack)) {
                    try {
                        msg.say(responseData.slack)
                    } catch (err) {
                        msg.say(err.message)
                    }
                } else if (isDefined(responseText)) {
                    try {
                        msg.say(responseText)
                    } catch (err) {
                        msg.say(err.message)
                    }
                } else if (isDefined(action) && isDefined(response.result.parameters.project_name)) {
                    db
                        .ref(msg.meta.team_id)
                        .child(msg.meta.channel_id)
                        .set({
                            project_name: response.result.parameters //response.result.parameters.project_name
                        })
                    msg.say({
                        text: 'Do you want to create a ticket for ' + response.result.parameters.project_name + '?',
                        attachments: [{
                            text: '',
                            fallback: 'Yes or No?',
                            callback_id: 'yesno_callback',
                            actions: [{
                                name: 'answer',
                                text: 'Yes',
                                type: 'button',
                                value: 'yes'
                            }, {
                                name: 'answer',
                                text: 'No',
                                type: 'button',
                                value: 'no'
                            }]
                        }]
                    }).route('handleDoitConfirmation', {
                        msg: msg,
                        apiairesponse: response
                    }, 60)
                }
            }
        })

        request.on('error', (error) => console.error(error))
        request.end()

    } catch (err) {
        console.error(err)
    }
})

slapp.route('handleDoitConfirmation', (msg, obj) => {
    var handleDoitConfirmationAction = function(action) {
        console.log(action ? 'true' : 'false');
        if (action) {
            var projectId = obj.apiairesponse.result.parameters.project_name;

            IFTTT.request({
                event: 'bug_' + projectId + '_trello',
                method: 'POST',
                params: {
                    'value1': obj.apiairesponse.result.resolvedQuery, // title
                    'value2': msg.body.user_name, // user_name
                    'value3': '' // description
                }
            }, function(err) {
                if (err) {
                    console.log('IFTTT error:', err);
                } else {
                    console.log('IFTTT post OK');
                }
            });

            msg.respond(msg.body.response_url, {
                text: 'done',
                delete_original: true
            })

        } else {
            msg.respond(msg.body.response_url, {
                text: 'No problem! Maybe later.',
                delete_original: true
            })
        }
    }

    if (msg.type !== 'action') {
        msg
            .say('Please choose a Yes or No button :wink:')
            .route('handleDoitConfirmation', state, 60)
        return
    }

    let answer = msg.body.actions[0].value
    handleDoitConfirmationAction(answer === 'yes')
    return
})



// // "Conversation" flow that tracks state - kicks off when user says hi, hello or hey
// slapp
//   .message('^(hi|hello|hey)$', ['direct_mention', 'direct_message'], (msg, text) => {
//     msg
//       .say(`${text}, how are you?`)
//       // sends next event from user to this route, passing along state
//       .route('how-are-you', { greeting: text })
//   })
//   .route('how-are-you', (msg, state) => {
//     var text = (msg.body.event && msg.body.event.text) || ''

//     // user may not have typed text as their next action, ask again and re-route
//     if (!text) {
//       return msg
//         .say("Whoops, I'm still waiting to hear how you're doing.")
//         .say('How are you?')
//         .route('how-are-you', state)
//     }

//     // add their response to state
//     state.status = text

//     msg
//       .say(`Ok then. What's your favorite color?`)
//       .route('color', state)
//   })
//   .route('color', (msg, state) => {
//     var text = (msg.body.event && msg.body.event.text) || ''

//     // user may not have typed text as their next action, ask again and re-route
//     if (!text) {
//       return msg
//         .say("I'm eagerly awaiting to hear your favorite color.")
//         .route('color', state)
//     }

//     // add their response to state
//     state.color = text

//     msg
//       .say('Thanks for sharing.')
//       .say(`Here's what you've told me so far: \`\`\`${JSON.stringify(state)}\`\`\``)
//     // At this point, since we don't route anywhere, the "conversation" is over
//   })

// // Can use a regex as well
// slapp.message(/^(thanks|thank you)/i, ['mention', 'direct_message'], (msg) => {
//   // You can provide a list of responses, and a random one will be chosen
//   // You can also include slack emoji in your responses
//   msg.say([
//     "You're welcome :smile:",
//     'You bet',
//     ':+1: Of course',
//     'Anytime :sun_with_face: :full_moon_with_face:'
//   ])
// })

// // demonstrate returning an attachment...
// slapp.message('attachment', ['mention', 'direct_message'], (msg) => {
//   msg.say({
//     text: 'Check out this amazing attachment! :confetti_ball: ',
//     attachments: [{
//       text: 'Slapp is a robust open source library that sits on top of the Slack APIs',
//       title: 'Slapp Library - Open Source',
//       image_url: 'https://storage.googleapis.com/beepboophq/_assets/bot-1.22f6fb.png',
//       title_link: 'https://beepboophq.com/',
//       color: '#7CD197'
//     }]
//   })
// })

// // Catch-all for any other responses not handled above
// slapp.message('.*', ['direct_mention', 'direct_message'], (msg) => {
//   // respond only 40% of the time
//   if (Math.random() < 0.4) {
//     msg.say([':wave:', ':pray:', ':raised_hands:'])
//   }
// })

// attach Slapp to express server
var server = slapp.attachToExpress(express())

// start http server
server.listen(port, (err) => {
    if (err) {
        return console.error(err)
    }

    console.log(`Listening on port ${port}`)
})
