/**
 * Constants and declarations.
 */
var d = require('domain').create();
var async = require('async');
var fs = require('fs');
var jsonfile = require('jsonfile');
var schedule = require('node-schedule');
var request = require('request');

var file = '/trivia/trivia_answers.json';
var gapFillURL = "https://gadfly-api.herokuapp.com/api/gap_fill_questions"
var mcqURL = "https://gadfly-api.herokuapp.com/api/multiple_choice_questions"
var articleCount=3;
var trivia_answers = [];
var trivia_keys = [];
var choiceReactions = {
    0: ':one:',
    1: ':two:',
    2: ':three:',
    3: ':four:',
}

// Reply pattern library
replies = {
    idk: new RegExp(/^(idk|not sure|i don\'t know|don\'t know')/i),
    stop: new RegExp(/^(stop|Stop|STOP)/i),
};

/**
 * Define a function for initiating a conversation on installation
 * With custom integrations, we don't have a way to find out who installed us, so we can't message them :(
 */
function onInstallation(bot, installer) {
    if (installer) {
        bot.startPrivateConversation({user: installer}, function(err, convo) {
            if (err) {
                console.log(err);
            } else {
                convo.say('I am a bot that has just joined your team');
                convo.say('You must now /invite me to a channel so that I can be of use!');
            }
        });
    }
}

/**
 * Configure the persistence options
 */
var config = {};
if (process.env.MONGOLAB_URI) {
    var BotkitStorage = require('botkit-storage-mongo');
    config = {
        storage: BotkitStorage({mongoUri: process.env.MONGOLAB_URI}),
    };
} else {
    config = {
        json_file_store: ((process.env.TOKEN)?'./db_slack_bot_ci/':'./db_slack_bot_a/'), //use a different name if an app or CI
    };
}

/**
 * Are being run as an app or a custom integration? The initialization will differ, depending
 */
if (process.env.TOKEN || process.env.SLACK_TOKEN) {
    //Treat this as a custom integration
    var customIntegration = require('./lib/custom_integrations');
    var token = (process.env.TOKEN) ? process.env.TOKEN : process.env.SLACK_TOKEN;
    var controller = customIntegration.configure(token, config, onInstallation);
} else if (process.env.CLIENT_ID && process.env.CLIENT_SECRET && process.env.PORT) {
    //Treat this as an app
    var app = require('./lib/apps');
    var controller = app.configure(process.env.PORT, process.env.CLIENT_ID, process.env.CLIENT_SECRET, config, onInstallation);
} else {
    console.log('Error: If this is a custom integration, please specify TOKEN in the environment.')
    console.log('If this is an app, please specify CLIENTID, CLIENTSECRET, and PORT in the environment')
    process.exit(1);
}

/*
 * A demonstration for how to handle websocket events. In this case, just log when we have and have not
 * been disconnected from the websocket. In the future, it would be super awesome to be able to specify
 * a reconnect policy, and do reconnections automatically. In the meantime, we aren't going to attempt reconnects,
 * WHICH IS A B0RKED WAY TO HANDLE BEING DISCONNECTED. So we need to fix this.
 *
 * TODO: fixed b0rked reconnect behavior
 */
// Handle events related to the websocket connection to Slack
controller.on('rtm_open', function(bot) {
    console.log('** The RTM api just connected!');
});

controller.on('rtm_close', function(bot) {
    console.log('** The RTM api just closed');
    // you may want to attempt to re-open
});

// much like a vampire, you must invite a bot into your channel
controller.on('bot_channel_join', function(bot, message) {
    bot.reply(message, "I'm here!")
});

// say hello
controller.hears(['hey', 'hello', 'hi', 'greetings', 'sup', 'yo'], 
                 ['direct_mention', 'mention', 'direct_message'],
                 function(bot, message) {
                    bot.reply(message,
                              'Hi there! I am TriviaBot, you can start a trivia game by saying' +
                              '"start trivia now" in this channel.');
 });

// stop
controller.hears(['stop', 'Stop', 'STOP', 'stahp', 'STAHP'],
                 ['direct_message','mention'],
                 function(bot, message) {
                    return bot.reply(message, 'I heard you loud and clear boss.');
});

/*
 * Core bot logic
 */
controller.hears('start trivia now', ['ambient', 'direct_message'], function(bot, message) {
    async.series([
        function(callback) {postTriviaIntro(bot, message, callback);},
        //function(callback) {getTriviaQuestions(callback);},
        function(callback) {waitNSecs(5, callback);},
        function(callback) {bot.reply(message, "Let's go!"); callback(null);},
        function(callback) {bot.reply(message, "Question number one!"); callback(null);},
        
        // Article 1
        function(callback) {waitNSecs(5, callback);},
        function(callback) {postTrivia(bot, './trivia/article0.json', message, callback);},
        function(callback) {waitNSecs(1, callback);},
        function(callback) {addReactions(bot, message, callback);},
        function(callback) {waitNSecs(25, callback);},
        
        // Article 2
        function(callback) {bot.reply(message, "Next question!"); callback(null);},
        function(callback) {waitNSecs(5, callback);},
        function(callback) {postTrivia(bot, './trivia/article1.json', message, callback);},
        function(callback) {waitNSecs(1, callback);},
        function(callback) {addReactions(bot, message, callback);},
        function(callback) {waitNSecs(20, callback);},
      
        // Article 3        
        function(callback) {bot.reply(message, "Time for the last question!");  callback(null);},
        function(callback) {waitNSecs(5, callback);},
        function(callback) {postTrivia(bot, './trivia/article2.json', message, callback);},
        function(callback) {waitNSecs(1, callback);},
        function(callback) {addReactions(bot, message, callback);},
        function(callback) {waitNSecs(20, callback);},
        
        // Calculate Score Here
        function(callback) {calculateScores(bot, message, callback);},
        function(callback) {waitNSecs(5, callback);},
        function(callback) {postTriviaOutro(bot, message, callback);}
    ]);
});

// monitor last question for answers
controller.on('reaction_added', function(bot, message) {
    // session.storage is the file that stores the id of the message that we care about

    console.log(message.reaction);
    if (message.reaction == "one" || message.reaction == "two" || message.reaction == "three" || message.reaction == "four") {
        var targetMsg = fs.readFileSync('session.storage');
        var correct_answer = trivia_keys[message.item.ts].replace(":", "").replace(":", "");
        if (message.user != bot.identity.id &&
            message.item.ts == targetMsg &&
            message.reaction == correct_answer) {
            trivia_answers.push(message);
        }
    }
});

// introduce yourself to the trivia crowd!
function postTriviaIntro(bot, message, callback) {
    var intro = 'Hi everyone <!here>, it\'s time to play some trivia!' + ' ' + 
                'I\'ve picked some of today\'s popular articles and will ask you 3 questions. \n\n' +
                '* Click on the reactions to answer. You have 30 seconds for each question.\n' +
                '* 1 point for answering correctly :nerd_face: \n' + 
                '* 1 bonus point for answering first :zap:\n' +
                '* Scores will be posted automatically at the end.\n' +
                '-----------------------\n';
    bot.reply(message, intro);
    callback(null);
}

// Say thanks!
function postTriviaOutro(bot, message, callback) {
    var msg = 'Thanks for playing!';
    bot.reply(message, msg);
    callback(null);
}

function getTriviaQuestions(callback) {
    request.get({
      url: "https://api.nytimes.com/svc/mostpopular/v2/mostviewed/all-sections/1.json",
      qs: {
        'api-key': "f5216a41176d45d5ab8904d74eb88d21"
      },
    }, function(err, response, body) {
        body = JSON.parse(body);
        
        for(var i=0; i < articleCount; i++) {
            var filename = './trivia/article' + i + '.json';
            apiURL = mcqURL + "?url=" + body.results[i].url + '&limit=1';
            r = request.get(apiURL)
                .on('error', function(err) {
                    console.log(err)
                })
                .pipe(fs.createWriteStream('./trivia/article' + i + '.json'));
            }
        }
    );
    callback(null);
}

// ask the trivia question with the choices
function postTrivia(bot, filename, message, callback) {
    var obj = JSON.parse(fs.readFileSync(filename));
    q = obj.questions[0];
    question = q.question;
    currentChannel = message.channel;
    choices = constructAnswerChoices(q.answer_choices);
    answer_idx = answerIdx(q.answer_choices, q.answer);
    answer_reaction = choiceReactions[answer_idx];
    saveAnswer(bot, message, answer_reaction);
    bot.reply(message, q.question + '\n\n' + choices);
    callback(null);
}

// helper to identify the right answer for a question
function answerIdx(answer_choices, answer) {
    for(var i=0; i < answer_choices.length; i++) {
        if(answer_choices[i] == answer) {
            return i;
        }
    }
    return -1;
}

// save the correct answer to trivia_keys 
function saveAnswer(bot, message, correct_answer, callback) {
    var currentChannel = message.channel;
    
    bot.api.channels.history({
        channel: currentChannel,
        count: 1,
        inclusive: 1
    }, function(err, body) {
            if (err) {
                console.log(err);
            }
            msg_id = body.messages[0].ts;
            trivia_keys[msg_id] = correct_answer;
    });
}

// return answer choices
function constructAnswerChoices(answer_choices) {
    var choices = "";
    for(var i=0; i < answer_choices.length; i++) {
        choices = choices + (i+1) + ')\t' + answer_choices[i] + '\n';
    }

    return choices;
}

// use the slack api to locate the last message in the channel we are in right now 
// then use the slack api to add reactions to that message
function addReactions(bot, message, callback) {
    var currentChannel = message.channel;
    bot.api.channels.history({
        channel: currentChannel,
        count: 1,
        inclusive: 1
    }, function(err, body) {
        if (err) {
            console.log(err);
        }
        lastMsg = body.messages[0];
        fs.writeFileSync('session.storage', lastMsg.ts, 'utf8');
        bot.api.reactions.add({
            timestamp: lastMsg.ts,
            channel: currentChannel,
            name: 'one'
        }, function() {
            bot.api.reactions.add({
                timestamp: lastMsg.ts,
                channel: currentChannel,
                name: 'two'
            }, function() {
                bot.api.reactions.add({
                    timestamp: lastMsg.ts,
                    channel: currentChannel,
                    name: 'three'
                }, function() {
                    bot.api.reactions.add({
                        timestamp: lastMsg.ts,
                        channel: currentChannel,
                        name: 'four'
                    });
                });
            });
        });
    });
    callback(null);
}

// Calculate scores for trivia
function calculateScores(bot, message, callback) {
    // Save score to json
    jsonfile.writeFileSync('trivia_answers.json', trivia_answers, {'flag': 'w'});
    var currentChannel = message.channel; 
    bot.reply(message, "*Here are the final scores!* :trophy: *drumroll*");
    
    var scores = [];
    var last_answer;
    // Calculate correct answer scores
    for(var i=0; i < trivia_answers.length; i++) {
        if(trivia_answers[i].user in scores) {
            scores[trivia_answers[i].user] = scores[trivia_answers[i].user] + 1;
        } else {
            scores[trivia_answers[i].user] = 1;
        }
        // Add bonus point for first to answer
        if (last_answer == undefined || last_answer != trivia_answers[i].item.ts) {
            scores[trivia_answers[i].user] = scores[trivia_answers[i].user] + 1;
        }
        last_answer = trivia_answers[i].item.ts;
    }
    
    for(var i=0; i < trivia_keys.length; i++) {
        bot.reply(message, (i + 1) + ")\t" + trivia_keys[i].replace(":", "").replace(":", ""));
    }

    // Get user names and report scores
    for(u in scores) {
        bot.api.users.info(
            {user: u},
            function(err, res) {
                score_message = res.user.name + " : " + scores[res.user.id] + "\n";
                bot.reply(message, score_message);
            }
        );
    }

    callback(null);
}

// utility function that waits n seconds; n passed as a parameter
function waitNSecs(n, callback) {
    n = n * 1000;
    setTimeout(function () {
      callback(null);
    }, n);
}

// for personality
controller.hears(['who are you','are you a bot', 
                  'what are you', 'what\'s your purpose',
                  'why are you here', 'what do you do'], 
                 ['direct_message','mention','direct_mention', 'ambient'],
                 function(bot, message) {
                    bot.api.reactions.add({
                        timestamp: message.ts,
                        channel: message.channel,
                        name: 'robot_face',
                    }, function(err) {
                        if (err) {
                            console.log(err)
                        }
                        bot.reply(message, 'I\'m just a poor bot, I need no sympathy, Because I\'m easy come, easy go.');
                    });
                });

controller.hears('open the (.*) doors',['direct_message','mention'], function(bot, message) {
  var doorType = message.match[1]; //match[1] is the (.*) group. match[0] is the entire group (open the (.*) doors).
  if (doorType === 'pod bay') {
    return bot.reply(message, 'I\'m sorry, Dave. I\'m afraid I can\'t do that.');
  }
  return bot.reply(message, 'Okay');
});
