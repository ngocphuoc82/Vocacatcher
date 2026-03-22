/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect } from 'react';

declare global {
  interface Window {
    app: any;
    arEngine: any;
    soundSystem: any;
    Hands: any;
    Camera: any;
    drawConnectors: any;
    drawLandmarks: any;
    HAND_CONNECTIONS: any;
    SpeechSynthesisUtterance: any;
  }
}

let audioCtx: AudioContext | null = null;

const soundSystem = {
    playTone(freq: number, duration: number, type: OscillatorType = 'sine') {
        if (!audioCtx) return;
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
        
        gain.gain.setValueAtTime(0.5, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + duration);
        
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        
        osc.start();
        osc.stop(audioCtx.currentTime + duration);
    },
    playCorrect() {
        this.playTone(523.25, 0.1, 'sine'); 
        setTimeout(() => this.playTone(659.25, 0.1, 'sine'), 100); 
        setTimeout(() => this.playTone(783.99, 0.3, 'sine'), 200); 
    },
    playWrong() {
        this.playTone(300, 0.2, 'sawtooth');
        setTimeout(() => this.playTone(250, 0.4, 'sawtooth'), 200);
    }
};

const arEngine = {
    camera: null as any,
    hands: null as any,
    flyingObjects: [] as any[],
    animationId: null as any,
    isGrabbing: false,
    lastGrabTime: 0,
    
    async start() {
        const videoEl = document.getElementById('webcam') as HTMLVideoElement;
        const canvasEl = document.getElementById('output_canvas') as HTMLCanvasElement;
        if (!videoEl || !canvasEl) return;
        const ctx = canvasEl.getContext('2d');
        
        document.getElementById('ar-loading')?.classList.remove('hidden');
        
        const resizeCanvas = () => {
            canvasEl.width = window.innerWidth;
            canvasEl.height = window.innerHeight;
        };
        resizeCanvas();
        window.addEventListener('resize', resizeCanvas);

        try {
            if (videoEl && videoEl.srcObject) {
                (videoEl.srcObject as MediaStream).getTracks().forEach(track => track.stop());
                videoEl.srcObject = null;
            }

            if (!this.hands) {
                this.hands = new window.Hands({locateFile: (file: string) => {
                    return `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`;
                }});
                this.hands.setOptions({
                    maxNumHands: 1,
                    modelComplexity: 1, 
                    minDetectionConfidence: 0.7,
                    minTrackingConfidence: 0.7
                });
                this.hands.onResults((results: any) => this.onResults(results, canvasEl, ctx));
            }

            if (!this.camera) {
                this.camera = new window.Camera(videoEl, {
                    onFrame: async () => {
                        if (this.hands && videoEl.readyState === 4) {
                            await this.hands.send({image: videoEl});
                        }
                    },
                    width: 1280,
                    height: 720,
                    facingMode: "user"
                });
            }
            
            await this.camera.start();
            
            document.getElementById('ar-loading')?.classList.add('hidden');
            app.loadQuestion();
            this.loop();
            
        } catch (err: any) {
            console.error("[CONSOLE_ERROR] Camera Error:", err);
            document.getElementById('ar-loading')?.classList.add('hidden');
            
            let errorMsg = "Unable to start Camera. Please grant Camera access to this website.";
            if (err.name === 'NotReadableError' || (err.message && err.message.includes('Device in use'))) {
                errorMsg = "Error: Your camera is being used by another application (Zoom, Meet...). Please close them and try again!";
            }
            
            app.showModal('Camera Error', errorMsg, 'warning', () => {
                app.switchScreen('home');
            }, false);
        }
    },

    stop() {
        if (this.camera) {
            this.camera.stop();
        }
        const videoEl = document.getElementById('webcam') as HTMLVideoElement;
        if (videoEl && videoEl.srcObject) {
            (videoEl.srcObject as MediaStream).getTracks().forEach(track => track.stop());
            videoEl.srcObject = null;
        }
        if (this.animationId) {
            cancelAnimationFrame(this.animationId);
        }
        const container = document.getElementById('words-container');
        if (container) container.innerHTML = '';
        this.flyingObjects = [];
        this.isGrabbing = false;
    },

    onResults(results: any, canvasEl: HTMLCanvasElement, ctx: CanvasRenderingContext2D) {
        ctx.save();
        ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
        
        if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
            const landmarks = results.multiHandLandmarks[0];
            
            window.drawConnectors(ctx, landmarks, window.HAND_CONNECTIONS, {color: '#ffffff', lineWidth: 4});
            window.drawLandmarks(ctx, landmarks, {color: '#4f46e5', lineWidth: 2, radius: 5});

            const thumbTip = landmarks[4];
            const indexTip = landmarks[8];
            const middleTip = landmarks[12];
            const wrist = landmarks[0];
            const middleMCP = landmarks[9];

            const W = canvasEl.width;
            const H = canvasEl.height;
            
            const pinchDist = Math.hypot(thumbTip.x - indexTip.x, thumbTip.y - indexTip.y);
            const palmSize = Math.hypot(wrist.x - middleMCP.x, wrist.y - middleMCP.y);
            
            // Ignore false positives or hands that are too far away
            if (palmSize < 0.03) {
                ctx.restore();
                return;
            }

            // A tight pinch (thumb and index very close)
            const isPinching = pinchDist < (palmSize * 0.25);
            
            // A closed fist (middle finger tip curled towards wrist)
            const middleTipToWrist = Math.hypot(middleTip.x - wrist.x, middleTip.y - wrist.y);
            const isFist = middleTipToWrist < (palmSize * 1.2);

            const isCatching = isPinching || isFist;
            
            // Determine interaction point
            let interactX = (thumbTip.x + indexTip.x) / 2;
            let interactY = (thumbTip.y + indexTip.y) / 2;
            
            if (isFist && !isPinching) {
                interactX = middleMCP.x;
                interactY = middleMCP.y;
            }

            const canvasDrawX = interactX * W;
            const canvasDrawY = interactY * H;
            
            const screenX = (1 - interactX) * W;
            const screenY = interactY * H;

            ctx.beginPath();
            ctx.arc(
                canvasDrawX,
                canvasDrawY, 
                isCatching ? 30 : 15, 
                0, 2 * Math.PI
            );
            ctx.fillStyle = isCatching ? 'rgba(239, 68, 68, 0.8)' : 'rgba(59, 130, 246, 0.5)';
            ctx.fill();
            if (isCatching) {
                ctx.lineWidth = 4;
                ctx.strokeStyle = 'white';
                ctx.stroke();
            }

            const now = Date.now();
            if (isCatching) {
                // Continuously check collision while catching to allow "sweeping" grabs
                if (now - this.lastGrabTime > 800) {
                    this.isGrabbing = true;
                    this.checkCollision(screenX, screenY);
                }
            } else {
                this.isGrabbing = false;
            }
        }
        ctx.restore();
    },

    spawnWords(answers: any[]) {
        const container = document.getElementById('words-container');
        if (!container) return;
        container.innerHTML = '';
        this.flyingObjects = [];

        let speedMult = app.state.gameSpeed / 5;

        const shuffled = [...answers].sort(() => Math.random() - 0.5);

        shuffled.forEach(ans => {
            const el = document.createElement('div');
            el.className = 'flying-word';
            el.innerText = ans.text;
            
            // Fallback: Allow clicking the word directly
            el.onclick = () => {
                if (app.state.gameState === 'PLAYING') {
                    const obj = this.flyingObjects.find(o => o.el === el);
                    if (obj) {
                        this.lastGrabTime = Date.now();
                        app.state.gameState = 'FEEDBACK';
                        
                        obj.el.style.transform = 'translate(-50%, -50%) scale(1.4)';
                        obj.el.style.backgroundImage = 'none';
                        
                        if (obj.isCorrect) {
                            obj.el.style.backgroundColor = '#22c55e';
                            obj.el.style.boxShadow = '0 0 25px rgba(34, 197, 94, 0.9)';
                        } else {
                            obj.el.style.backgroundColor = '#ef4444';
                            obj.el.style.boxShadow = '0 0 25px rgba(239, 68, 68, 0.9)';
                        }
                        obj.el.style.zIndex = '999';
                        
                        setTimeout(() => {
                            app.handleAnswer(obj.isCorrect, obj.el);
                        }, 400);
                    }
                }
            };

            container.appendChild(el);

            let w = el.offsetWidth || 100;
            let h = el.offsetHeight || 50;
            let x = Math.random() * (window.innerWidth - w - 100) + 50 + w/2;
            let y = window.innerHeight * 0.4 + Math.random() * (window.innerHeight * 0.4);

            let dx = (Math.random() - 0.5) * 6 * speedMult;
            let dy = (Math.random() - 0.5) * 6 * speedMult;
            
            let minSpeed = 1.5 * speedMult;
            if(Math.abs(dx) < minSpeed) dx = dx > 0 ? minSpeed : -minSpeed;
            if(Math.abs(dy) < minSpeed) dy = dy > 0 ? minSpeed : -minSpeed;

            this.flyingObjects.push({
                el: el, isCorrect: ans.isCorrect,
                x: x, y: y, dx: dx, dy: dy,
                width: w, height: h
            });
        });
    },

    loop() {
        if (app.state.gameState === 'PLAYING') {
            const W = window.innerWidth;
            const H = window.innerHeight;
            const topBoundary = H * 0.35;

            this.flyingObjects.forEach(obj => {
                obj.x += obj.dx;
                obj.y += obj.dy;

                if (obj.x - obj.width/2 <= 0) { obj.x = obj.width/2; obj.dx *= -1; }
                if (obj.x + obj.width/2 >= W) { obj.x = W - obj.width/2; obj.dx *= -1; }
                if (obj.y - obj.height/2 <= topBoundary) { obj.y = topBoundary + obj.height/2; obj.dy *= -1; }
                if (obj.y + obj.height/2 >= H) { obj.y = H - obj.height/2; obj.dy *= -1; }

                obj.el.style.left = obj.x + 'px';
                obj.el.style.top = obj.y + 'px';
            });
        }
        
        this.animationId = requestAnimationFrame(this.loop.bind(this));
    },

    checkCollision(handX: number, handY: number) {
        if (app.state.gameState !== 'PLAYING') return;

        let closestObj: any = null;
        let minDistance = Infinity;

        for (let i = 0; i < this.flyingObjects.length; i++) {
            const obj = this.flyingObjects[i];
            
            const dist = Math.hypot(handX - obj.x, handY - obj.y);
            
            const grabRadius = Math.max(obj.width, obj.height) / 2 + 35;

            if (dist <= grabRadius && dist < minDistance) {
                closestObj = obj;
                minDistance = dist;
            }
        }

        if (closestObj) {
            app.state.gameState = 'FEEDBACK';
            this.lastGrabTime = Date.now();
            
            closestObj.el.style.transform = 'translate(-50%, -50%) scale(1.4)';
            closestObj.el.style.backgroundImage = 'none';
            
            if (closestObj.isCorrect) {
                closestObj.el.style.backgroundColor = '#22c55e';
                closestObj.el.style.boxShadow = '0 0 25px rgba(34, 197, 94, 0.9)';
            } else {
                closestObj.el.style.backgroundColor = '#ef4444';
                closestObj.el.style.boxShadow = '0 0 25px rgba(239, 68, 68, 0.9)';
            }
            closestObj.el.style.zIndex = '999';
            
            setTimeout(() => {
                app.handleAnswer(closestObj.isCorrect, closestObj.el);
            }, 400);
        }
    }
};

const app = {
    state: {
        topics: [] as any[],
        currentTopicId: 'default',
        stats: [] as any[],
        gameSpeed: 5,
        currentStudent: '',
        currentQIndex: 0,
        score: 0,
        gameState: 'IDLE'
    },
    
    getCurrentTopic() {
        return this.state.topics.find((t: any) => t.id === this.state.currentTopicId) || this.state.topics[0];
    },

    screens: ['screen-home', 'screen-teacher', 'screen-student-login', 'screen-game'],
    
    init() {
        const savedData = localStorage.getItem('arVocabCatcherData');
        if (savedData) {
            const parsed = JSON.parse(savedData);
            if (parsed.topics) {
                this.state.topics = parsed.topics;
                this.state.currentTopicId = parsed.currentTopicId || parsed.topics[0].id;
            } else if (parsed.questions) {
                this.state.topics = [{ id: 'default', name: 'Default Topic', questions: parsed.questions }];
                this.state.currentTopicId = 'default';
            }
            this.state.stats = parsed.stats || [];
            this.state.gameSpeed = parsed.gameSpeed || 5;
        } else {
            this.state.topics = [{
                id: 'default',
                name: 'Default Topic',
                questions: [
                    {
                        id: 1, 
                        text: "Listen and catch the correct word!", 
                        speakText: "Apple", 
                        audioUrl: null,
                        answers: [
                            { text: "Apple", isCorrect: true },
                            { text: "Banana", isCorrect: false },
                            { text: "Orange", isCorrect: false },
                            { text: "Grape", isCorrect: false }
                        ]
                    },
                    {
                        id: 2, 
                        text: "Find the word you just heard!", 
                        speakText: "Elephant",
                        audioUrl: null,
                        answers: [
                            { text: "Lion", isCorrect: false },
                            { text: "Elephant", isCorrect: true },
                            { text: "Tiger", isCorrect: false },
                            { text: "Monkey", isCorrect: false }
                        ]
                    }
                ]
            }];
            this.state.currentTopicId = 'default';
            this.saveData();
        }
        
        const speedSlider = document.getElementById('t-speed-slider') as HTMLInputElement;
        const speedDisplay = document.getElementById('t-speed-display');
        if (speedSlider) speedSlider.value = this.state.gameSpeed.toString();
        if (speedDisplay) speedDisplay.innerText = this.state.gameSpeed.toString();
    },

    saveData() {
        localStorage.setItem('arVocabCatcherData', JSON.stringify({
            topics: this.state.topics,
            currentTopicId: this.state.currentTopicId,
            stats: this.state.stats,
            gameSpeed: this.state.gameSpeed
        }));
    },

    switchScreen(screenId: string) {
        if (!audioCtx) audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
        if (audioCtx.state === 'suspended') audioCtx.resume();
        
        if ('speechSynthesis' in window) {
            const unlockMsg = new SpeechSynthesisUtterance('');
            window.speechSynthesis.speak(unlockMsg);
        }

        this.screens.forEach(s => {
            const el = document.getElementById(s);
            if (el) el.classList.add('hidden');
        });
        
        if (screenId === 'home') {
            arEngine.stop();
            document.body.style.overflow = ''; 
        } else if (screenId === 'teacher') {
            this.renderTeacherView();
            document.body.style.overflow = '';
        } else if (screenId === 'student-login') {
            const topicSelect = document.getElementById('s-topic-select') as HTMLSelectElement;
            if (topicSelect) {
                topicSelect.innerHTML = '';
                this.state.topics.forEach((t: any) => {
                    const opt = document.createElement('option');
                    opt.value = t.id;
                    opt.text = t.name + ` (${t.questions.length} words)`;
                    if (t.id === this.state.currentTopicId) opt.selected = true;
                    topicSelect.appendChild(opt);
                });
            }
        } else if (screenId === 'game') {
            document.body.style.overflow = 'hidden';
        }
        
        const targetScreen = document.getElementById('screen-' + screenId);
        if (targetScreen) targetScreen.classList.remove('hidden');
    },

    updateSpeedDisplay(val: string) {
        const display = document.getElementById('t-speed-display');
        if (display) display.innerText = val;
    },

    saveSpeed(val: string) {
        this.state.gameSpeed = parseInt(val);
        this.saveData();
    },

    changeTopic(topicId: string) {
        this.state.currentTopicId = topicId;
        this.saveData();
        this.renderTeacherView();
    },

    showPrompt(title: string, message: string, onConfirm: (val: string) => void) {
        const modal = document.getElementById('custom-prompt-modal');
        const titleEl = document.getElementById('custom-prompt-title');
        const msgEl = document.getElementById('custom-prompt-message');
        const inputEl = document.getElementById('custom-prompt-input') as HTMLInputElement;
        const cancelBtn = document.getElementById('custom-prompt-cancel');
        const confirmBtn = document.getElementById('custom-prompt-confirm');

        if (!modal || !titleEl || !msgEl || !inputEl || !cancelBtn || !confirmBtn) return;

        titleEl.innerText = title;
        msgEl.innerText = message;
        inputEl.value = '';

        confirmBtn.onclick = () => {
            const val = inputEl.value.trim();
            if (val) {
                modal.classList.add('hidden');
                onConfirm(val);
            }
        };
        cancelBtn.onclick = () => {
            modal.classList.add('hidden');
        };

        modal.classList.remove('hidden');
        inputEl.focus();
    },

    createNewTopic() {
        this.showPrompt("New Topic", "Enter new topic name:", (name) => {
            const newId = 'topic_' + Date.now();
            this.state.topics.push({
                id: newId,
                name: name,
                questions: []
            });
            this.state.currentTopicId = newId;
            this.saveData();
            this.renderTeacherView();
        });
    },

    deleteCurrentTopic() {
        if (this.state.topics.length <= 1) {
            this.showModal('Cannot Delete', 'You must have at least one topic.', 'warning', () => {}, false);
            return;
        }
        this.showModal('Delete Topic?', `Are you sure you want to delete the topic "${this.getCurrentTopic().name}" and all its words?`, 'warning', () => {
            this.state.topics = this.state.topics.filter((t: any) => t.id !== this.state.currentTopicId);
            this.state.currentTopicId = this.state.topics[0].id;
            this.saveData();
            this.renderTeacherView();
        });
    },

    renderTeacherView() {
        // Render Topic Select
        const topicSelect = document.getElementById('t-topic-select') as HTMLSelectElement;
        if (topicSelect) {
            topicSelect.innerHTML = '';
            this.state.topics.forEach((t: any) => {
                const opt = document.createElement('option');
                opt.value = t.id;
                opt.text = t.name + ` (${t.questions.length} words)`;
                if (t.id === this.state.currentTopicId) opt.selected = true;
                topicSelect.appendChild(opt);
            });
        }

        const qList = document.getElementById('t-question-list');
        if (!qList) return;
        qList.innerHTML = '';
        if (this.getCurrentTopic().questions.length === 0) {
            qList.innerHTML = '<div class="text-center p-6 bg-gray-50 rounded-xl border-dashed border-2 border-gray-200"><p class="text-gray-500 italic">No words added yet. Please add them on the left.</p></div>';
        } else {
            this.getCurrentTopic().questions.forEach((q: any, idx: number) => {
                const correctAns = q.answers.find((a: any) => a.isCorrect)?.text || '';
                const audioBadge = q.audioUrl 
                    ? '<span class="px-2 py-1 bg-green-100 text-green-700 text-xs rounded-full font-bold ml-2"><i class="fa-solid fa-file-audio"></i> Has MP3</span>' 
                    : `<span class="px-2 py-1 bg-indigo-100 text-indigo-700 text-xs rounded-full font-bold ml-2"><i class="fa-solid fa-robot"></i> AI voice: "${q.speakText}"</span>`;
                    
                qList.innerHTML += `
                    <div class="bg-white p-4 rounded-xl border border-gray-200 shadow-sm flex justify-between items-center hover:border-indigo-300 transition-colors">
                        <div>
                            <div class="font-bold text-gray-800">Word ${idx + 1}: <span class="text-indigo-600">${correctAns}</span></div>
                            <div class="mt-1 flex items-center">
                                <div class="text-xs text-gray-500 mr-2">Hint: "${q.text}"</div>
                                ${audioBadge}
                            </div>
                        </div>
                        <div class="flex gap-2">
                            <button onclick="window.app.previewAudio(${q.id})" class="w-10 h-10 rounded-full bg-indigo-50 text-indigo-600 hover:bg-indigo-600 hover:text-white transition-colors shadow-sm"><i class="fa-solid fa-volume-high"></i></button>
                            <button onclick="window.app.teacherDeleteQuestion(${q.id})" class="w-10 h-10 rounded-full bg-red-50 text-red-500 hover:bg-red-500 hover:text-white transition-colors shadow-sm"><i class="fa-solid fa-trash"></i></button>
                        </div>
                    </div>
                `;
            });
        }

        const sList = document.getElementById('t-stats-list');
        if (!sList) return;
        sList.innerHTML = '';
        if (this.state.stats.length === 0) {
            sList.innerHTML = '<tr><td colspan="4" class="p-6 text-center text-gray-400 italic">Scores will appear here after students play.</td></tr>';
        } else {
            this.state.stats.slice().reverse().forEach(stat => {
                const ratio = stat.score / stat.total;
                let rank = 'Good'; let rankColor = 'text-blue-600 bg-blue-100';
                if (ratio === 1) { rank = 'Excellent'; rankColor = 'text-emerald-700 bg-emerald-100'; }
                else if (ratio < 0.5) { rank = 'Needs Practice'; rankColor = 'text-red-600 bg-red-100'; }

                sList.innerHTML += `
                    <tr class="border-b border-gray-50 hover:bg-gray-50 transition-colors">
                        <td class="p-3 font-bold text-gray-800">${stat.name}</td>
                        <td class="p-3 text-sm text-gray-500"><i class="fa-regular fa-clock mr-1"></i>${stat.date}</td>
                        <td class="p-3 text-center font-black text-indigo-600 text-lg">${stat.score}/${stat.total}</td>
                        <td class="p-3 text-center"><span class="px-3 py-1 rounded-full text-xs font-bold ${rankColor}">${rank}</span></td>
                    </tr>
                `;
            });
        }
    },

    teacherAddQuestion() {
        const text = (document.getElementById('t-question') as HTMLInputElement).value.trim() || "Listen and catch the correct word!";
        const speakText = (document.getElementById('t-speak-text') as HTMLInputElement).value.trim();
        const ans1 = (document.getElementById('t-ans-correct') as HTMLInputElement).value.trim();
        const ans2 = (document.getElementById('t-ans-wrong1') as HTMLInputElement).value.trim();
        const ans3 = (document.getElementById('t-ans-wrong2') as HTMLInputElement).value.trim();
        const ans4 = (document.getElementById('t-ans-wrong3') as HTMLInputElement).value.trim();
        const audioFile = (document.getElementById('t-audio') as HTMLInputElement).files?.[0];

        if (!ans1 || !ans2 || !ans3 || !ans4) {
            this.showTeacherMsg('<i class="fa-solid fa-circle-exclamation"></i> Please enter the correct word and 3 wrong words!', 'red');
            return;
        }

        if (!speakText && !audioFile) {
            this.showTeacherMsg('<i class="fa-solid fa-circle-exclamation"></i> Please enter a word for AI to read OR upload an MP3!', 'red');
            return;
        }

        const processAdd = (audioUrl: string | null = null) => {
            const newQ = {
                id: Date.now(),
                text: text,
                speakText: speakText,
                audioUrl: audioUrl,
                answers: [
                    { text: ans1, isCorrect: true },
                    { text: ans2, isCorrect: false },
                    { text: ans3, isCorrect: false },
                    { text: ans4, isCorrect: false }
                ]
            };
            this.getCurrentTopic().questions.push(newQ);
            this.saveData();
            this.renderTeacherView();

            (document.getElementById('t-speak-text') as HTMLInputElement).value = '';
            (document.getElementById('t-ans-correct') as HTMLInputElement).value = '';
            (document.getElementById('t-ans-wrong1') as HTMLInputElement).value = '';
            (document.getElementById('t-ans-wrong2') as HTMLInputElement).value = '';
            (document.getElementById('t-ans-wrong3') as HTMLInputElement).value = '';
            (document.getElementById('t-audio') as HTMLInputElement).value = '';
            
            this.showTeacherMsg('<i class="fa-solid fa-circle-check"></i> Added successfully!', 'emerald');
        };

        if (audioFile) {
            const url = URL.createObjectURL(audioFile);
            processAdd(url);
        } else {
            processAdd();
        }
    },

    showTeacherMsg(html: string, color: string) {
        const msgBox = document.getElementById('t-msg');
        if (!msgBox) return;
        msgBox.innerHTML = html;
        msgBox.className = `text-sm text-center mt-3 font-bold text-${color}-600 block bg-${color}-50 py-2 rounded-lg`;
        setTimeout(() => { msgBox.classList.add('hidden'); }, 3000);
    },

    teacherDeleteQuestion(id: number) {
        this.getCurrentTopic().questions = this.getCurrentTopic().questions.filter((q: any) => q.id !== id);
        this.saveData();
        this.renderTeacherView();
    },

    previewAudio(id: number) {
        const q = this.getCurrentTopic().questions.find((q: any) => q.id === id);
        if (q) {
            if (q.audioUrl) {
                new Audio(q.audioUrl).play();
            } else if (q.speakText && 'speechSynthesis' in window) {
                window.speechSynthesis.cancel();
                const utterance = new SpeechSynthesisUtterance(q.speakText);
                utterance.lang = 'en-US';
                utterance.rate = 0.9;
                window.speechSynthesis.speak(utterance);
            }
        }
    },

    showModal(title: string, message: string, type: 'warning' | 'info', onConfirm: () => void, showCancel = true) {
        const modal = document.getElementById('custom-modal');
        const titleEl = document.getElementById('custom-modal-title');
        const msgEl = document.getElementById('custom-modal-message');
        const iconEl = document.getElementById('custom-modal-icon');
        const cancelBtn = document.getElementById('custom-modal-cancel');
        const confirmBtn = document.getElementById('custom-modal-confirm');

        if (!modal || !titleEl || !msgEl || !iconEl || !cancelBtn || !confirmBtn) return;

        titleEl.innerText = title;
        msgEl.innerText = message;

        if (type === 'warning') {
            iconEl.className = 'w-16 h-16 mx-auto bg-red-100 text-red-500 rounded-full flex items-center justify-center text-3xl mb-4';
            iconEl.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i>';
            confirmBtn.className = 'px-4 py-2 bg-red-500 hover:bg-red-600 text-white font-semibold rounded-xl transition-colors shadow-lg shadow-red-500/30';
        } else {
            iconEl.className = 'w-16 h-16 mx-auto bg-indigo-100 text-indigo-500 rounded-full flex items-center justify-center text-3xl mb-4';
            iconEl.innerHTML = '<i class="fa-solid fa-circle-info"></i>';
            confirmBtn.className = 'px-4 py-2 bg-indigo-500 hover:bg-indigo-600 text-white font-semibold rounded-xl transition-colors shadow-lg shadow-indigo-500/30';
        }

        if (showCancel) {
            cancelBtn.classList.remove('hidden');
        } else {
            cancelBtn.classList.add('hidden');
        }

        confirmBtn.onclick = () => {
            modal.classList.add('hidden');
            onConfirm();
        };
        cancelBtn.onclick = () => {
            modal.classList.add('hidden');
        };

        modal.classList.remove('hidden');
    },

    clearStats() {
        this.showModal('Warning', 'Are you sure you want to clear the entire leaderboard?', 'warning', () => {
            this.state.stats = [];
            this.saveData();
            this.renderTeacherView();
        });
    },

    startStudentGame() {
        const name = (document.getElementById('s-name') as HTMLInputElement).value.trim();
        const topicSelect = document.getElementById('s-topic-select') as HTMLSelectElement;
        
        if (!name) {
            this.showModal('Wait!', 'Enter your astronaut name to begin!', 'warning', () => {}, false);
            return;
        }

        if (topicSelect && topicSelect.value) {
            this.state.currentTopicId = topicSelect.value;
            this.saveData();
        }

        if (this.getCurrentTopic().questions.length === 0) {
            this.showModal('No Words', "This topic hasn't got any words yet. Please choose another one!", 'warning', () => {}, false);
            return;
        }
        
        this.state.currentStudent = name;
        this.state.currentQIndex = 0;
        this.state.score = 0;
        this.switchScreen('game');
        
        arEngine.start();
    },

    loadQuestion() {
        if (this.state.currentQIndex >= this.getCurrentTopic().questions.length) {
            this.endGame(true);
            return;
        }

        const q = this.getCurrentTopic().questions[this.state.currentQIndex];
        const qNum = document.getElementById('g-q-num');
        const qTotal = document.getElementById('g-q-total');
        const gScore = document.getElementById('g-score');
        const gQText = document.getElementById('g-question-text');
        
        if (qNum) qNum.innerText = (this.state.currentQIndex + 1).toString();
        if (qTotal) qTotal.innerText = this.getCurrentTopic().questions.length.toString();
        if (gScore) gScore.innerText = this.state.score.toString();
        if (gQText) gQText.innerText = q.text;

        const btnAudio = document.getElementById('g-btn-audio');
        if (btnAudio) btnAudio.classList.remove('playing-audio');

        arEngine.spawnWords(q.answers);
        this.state.gameState = 'PLAYING';

        setTimeout(() => this.playCurrentAudio(), 800);
    },

    playCurrentAudio() {
        const q = this.getCurrentTopic().questions[this.state.currentQIndex];
        const btnAudio = document.getElementById('g-btn-audio');
        
        if (btnAudio) btnAudio.classList.add('playing-audio');
        
        if (q && q.audioUrl) {
            const audio = new Audio(q.audioUrl);
            audio.onended = () => btnAudio?.classList.remove('playing-audio');
            audio.play().catch(e => {
                console.error("Audio play failed", e);
                btnAudio?.classList.remove('playing-audio');
            });
        } else if (q && q.speakText && 'speechSynthesis' in window) {
            window.speechSynthesis.cancel();
            const utterance = new SpeechSynthesisUtterance(q.speakText);
            utterance.lang = 'en-US';
            utterance.rate = 0.85; 
            
            utterance.onend = () => btnAudio?.classList.remove('playing-audio');
            utterance.onerror = () => btnAudio?.classList.remove('playing-audio');
            
            window.speechSynthesis.speak(utterance);
        } else {
            if (btnAudio) btnAudio.classList.remove('playing-audio');
        }
    },

    handleAnswer(isCorrect: boolean, element: HTMLElement) {
        this.state.gameState = 'FEEDBACK';
        
        if ('speechSynthesis' in window) window.speechSynthesis.cancel();
        
        const container = document.getElementById('words-container');
        if (container) container.innerHTML = '';
        
        const overlay = document.getElementById('feedback-overlay');
        const fbText = document.getElementById('feedback-text');
        const fbIcon = document.getElementById('feedback-icon');

        if (!overlay || !fbText || !fbIcon) return;

        if (isCorrect) {
            this.state.score++;
            soundSystem.playCorrect();
            overlay.className = 'correct-bg';
            fbText.innerText = 'GREAT CATCH!';
            fbIcon.innerHTML = '<i class="fa-solid fa-face-laugh-squint"></i>';
        } else {
            soundSystem.playWrong();
            overlay.className = 'wrong-bg';
            fbText.innerText = 'MISSED!';
            fbIcon.innerHTML = '<i class="fa-solid fa-face-dizzy"></i>';
        }

        overlay.style.opacity = '1';
        
        setTimeout(() => {
            overlay.style.opacity = '0';
            this.state.currentQIndex++;
            this.loadQuestion();
        }, 2000);
    },

    endGame(completed = false) {
        if ('speechSynthesis' in window) window.speechSynthesis.cancel();
        
        if (completed) {
            const now = new Date();
            const pad = (n: number) => n < 10 ? '0'+n : n;
            const dateStr = `${pad(now.getHours())}:${pad(now.getMinutes())} ${pad(now.getDate())}/${pad(now.getMonth()+1)}`;
            this.state.stats.push({
                name: this.state.currentStudent,
                score: this.state.score,
                total: this.getCurrentTopic().questions.length,
                date: dateStr
            });
            this.saveData();
            
            setTimeout(() => {
                this.showModal('🌟 MISSION SUMMARY 🌟', `Congratulations astronaut: ${this.state.currentStudent}\nCorrect words caught: ${this.state.score} / ${this.getCurrentTopic().questions.length}`, 'info', () => {
                    this.switchScreen('home');
                }, false);
            }, 500);
        } else {
            this.switchScreen('home');
        }
    }
};

if (typeof window !== 'undefined') {
    window.app = app;
}

export default function App() {
    useEffect(() => {
        window.app.init();
    }, []);

    return (
        <>
            {/* SCREEN: HOME */}
            <div id="screen-home" className="flex flex-col items-center justify-center min-h-screen bg-gradient-to-br from-indigo-100 via-purple-100 to-pink-100 p-4">
                <div className="bg-white p-8 rounded-3xl shadow-xl max-w-md w-full text-center border-t-8 border-indigo-500">
                    <div className="relative w-24 h-24 mx-auto mb-4 bg-indigo-100 rounded-full flex items-center justify-center text-indigo-500">
                        <i className="fa-solid fa-headphones text-4xl absolute -ml-2 -mt-2"></i>
                        <i className="fa-solid fa-hand-sparkles text-2xl absolute ml-6 mt-6 text-purple-500"></i>
                    </div>
                    <h1 className="text-3xl font-extrabold text-gray-800 mb-2">AR Vocabulary Catcher</h1>
                    <p className="text-gray-500 mb-8 font-medium">Listen to the vocabulary and use your hand to catch the word!</p>
                    
                    <div className="space-y-4">
                        <button onClick={() => window.app.switchScreen('teacher')} className="w-full py-4 bg-gray-800 hover:bg-gray-900 text-white rounded-xl font-bold text-lg transition-colors flex items-center justify-center gap-2">
                            <i className="fa-solid fa-chalkboard-user"></i> Manage Questions (Teacher)
                        </button>
                        <button onClick={() => window.app.switchScreen('student-login')} className="w-full py-4 bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700 text-white rounded-xl font-bold text-xl transition-colors flex items-center justify-center gap-2 shadow-lg shadow-indigo-200">
                            <i className="fa-solid fa-play"></i> Student Play
                        </button>
                    </div>
                </div>
            </div>

            {/* SCREEN: TEACHER DASHBOARD */}
            <div id="screen-teacher" className="hidden min-h-screen bg-gray-50 p-6">
                <div className="max-w-6xl mx-auto pb-10">
                    <div className="flex justify-between items-center mb-8">
                        <h2 className="text-3xl font-bold text-gray-800"><i className="fa-solid fa-chalkboard-user mr-2 text-indigo-600"></i> Teacher Dashboard</h2>
                        <button onClick={() => window.app.switchScreen('home')} className="px-4 py-2 bg-white hover:bg-gray-100 text-gray-700 rounded-lg font-semibold transition-colors shadow-sm border">
                            <i className="fa-solid fa-house"></i> Home
                        </button>
                    </div>

                    <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                        {/* Left Column: Settings & Add Question */}
                        <div className="lg:col-span-1 space-y-6">
                            
                            {/* Topic Manager Card */}
                            <div className="bg-white p-6 rounded-2xl shadow-md border border-gray-100">
                                <h3 className="text-xl font-bold text-gray-800 mb-4 border-b pb-2"><i className="fa-solid fa-folder-open text-amber-500"></i> Question Topics</h3>
                                <div className="space-y-3">
                                    <select id="t-topic-select" onChange={(e) => window.app.changeTopic((e.target as HTMLSelectElement).value)} className="w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 outline-none font-semibold text-gray-700 bg-gray-50">
                                        {/* Populated by JS */}
                                    </select>
                                    <div className="flex gap-2">
                                        <button onClick={() => window.app.createNewTopic()} className="flex-1 py-2 bg-emerald-100 hover:bg-emerald-200 text-emerald-700 rounded-lg font-bold transition-colors text-sm">
                                            <i className="fa-solid fa-plus"></i> New Topic
                                        </button>
                                        <button onClick={() => window.app.deleteCurrentTopic()} className="flex-1 py-2 bg-red-100 hover:bg-red-200 text-red-700 rounded-lg font-bold transition-colors text-sm">
                                            <i className="fa-solid fa-trash"></i> Delete
                                        </button>
                                    </div>
                                </div>
                            </div>

                            {/* Global Settings Card */}
                            <div className="bg-white p-6 rounded-2xl shadow-md border border-gray-100">
                                <h3 className="text-xl font-bold text-gray-800 mb-4 border-b pb-2"><i className="fa-solid fa-gauge-high text-indigo-500"></i> Difficulty (Flying Speed)</h3>
                                <div className="flex items-center gap-4">
                                    <span className="text-gray-500 font-bold text-sm"><i className="fa-solid fa-turtle"></i> Turtle</span>
                                    <input type="range" id="t-speed-slider" min="1" max="10" defaultValue="5" className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-indigo-600" onInput={(e) => window.app.updateSpeedDisplay((e.target as HTMLInputElement).value)} onChange={(e) => window.app.saveSpeed((e.target as HTMLInputElement).value)} />
                                    <span className="text-gray-500 font-bold text-sm"><i className="fa-solid fa-bolt"></i> Lightning</span>
                                </div>
                                <div className="text-center mt-3 text-indigo-600 font-bold bg-indigo-50 rounded-lg py-2">
                                    Current Level: <span id="t-speed-display" className="text-xl">5</span>
                                </div>
                            </div>

                            {/* Add Question Form */}
                            <div className="bg-white p-6 rounded-2xl shadow-md border border-gray-100">
                                <h3 className="text-xl font-bold text-gray-800 mb-4 border-b pb-2"><i className="fa-solid fa-puzzle-piece text-emerald-500"></i> Create Vocabulary Round</h3>
                                <div className="space-y-4">
                                    <div>
                                        <label className="block text-sm font-semibold text-gray-600 mb-1">Hint Text</label>
                                        <input type="text" id="t-question" className="w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 outline-none" defaultValue="Listen and catch the correct word!" placeholder="Listen and catch the correct word!" />
                                    </div>
                                    
                                    <div className="bg-indigo-50 p-4 rounded-lg border border-indigo-100">
                                        <label className="block text-sm font-bold text-indigo-700 mb-1"><i className="fa-solid fa-robot"></i> AI Voice (English Word)</label>
                                        <input type="text" id="t-speak-text" className="w-full p-3 border border-indigo-300 rounded-lg focus:ring-2 focus:ring-indigo-500 outline-none font-bold" placeholder="e.g., Apple" />
                                    </div>

                                    <div className="text-center text-sm font-bold text-gray-400">- OR -</div>

                                    <div>
                                        <label className="block text-sm font-semibold text-gray-600 mb-1"><i className="fa-solid fa-file-audio"></i> Upload MP3 (Optional)</label>
                                        <input type="file" id="t-audio" accept="audio/*" className="w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-semibold file:bg-gray-100 file:text-gray-700 hover:file:bg-gray-200" />
                                    </div>

                                    <div className="mt-6 pt-4 border-t">
                                        <label className="block text-sm font-semibold text-emerald-600 mb-1"><i className="fa-solid fa-check-circle"></i> CORRECT WORD</label>
                                        <input type="text" id="t-ans-correct" className="w-full p-3 border border-emerald-300 bg-emerald-50 rounded-lg focus:ring-2 focus:ring-emerald-500 outline-none font-bold" placeholder="e.g., Apple" />
                                    </div>
                                    <div>
                                        <label className="block text-sm font-semibold text-red-600 mb-1"><i className="fa-solid fa-times-circle"></i> Wrong Word 1</label>
                                        <input type="text" id="t-ans-wrong1" className="w-full p-3 border border-red-200 bg-red-50 rounded-lg focus:ring-2 focus:ring-red-500 outline-none" placeholder="e.g., Banana" />
                                    </div>
                                    <div>
                                        <label className="block text-sm font-semibold text-red-600 mb-1"><i className="fa-solid fa-times-circle"></i> Wrong Word 2</label>
                                        <input type="text" id="t-ans-wrong2" className="w-full p-3 border border-red-200 bg-red-50 rounded-lg focus:ring-2 focus:ring-red-500 outline-none" placeholder="e.g., Orange" />
                                    </div>
                                    <div>
                                        <label className="block text-sm font-semibold text-red-600 mb-1"><i className="fa-solid fa-times-circle"></i> Wrong Word 3</label>
                                        <input type="text" id="t-ans-wrong3" className="w-full p-3 border border-red-200 bg-red-50 rounded-lg focus:ring-2 focus:ring-red-500 outline-none" placeholder="e.g., Grape" />
                                    </div>
                                    
                                    <button onClick={() => window.app.teacherAddQuestion()} className="w-full py-4 mt-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl font-bold transition-colors text-lg shadow-md shadow-indigo-200">
                                        <i className="fa-solid fa-plus"></i> Add to Game
                                    </button>
                                    <div id="t-msg" className="text-sm text-center mt-2 font-semibold hidden"></div>
                                </div>
                            </div>
                        </div>

                        {/* Right Column: Questions List & Stats */}
                        <div className="lg:col-span-2 space-y-6">
                            {/* Question List */}
                            <div className="bg-white p-6 rounded-2xl shadow-md border border-gray-100">
                                <h3 className="text-xl font-bold text-gray-800 mb-4 border-b pb-2"><i className="fa-solid fa-list-check text-indigo-500"></i> Words in Game</h3>
                                <div id="t-question-list" className="space-y-3 max-h-[400px] overflow-y-auto pr-2">
                                    {/* Populated by JS */}
                                </div>
                            </div>

                            {/* Student Results */}
                            <div className="bg-white p-6 rounded-2xl shadow-md border border-gray-100">
                                <div className="flex justify-between items-center mb-4 border-b pb-2">
                                    <h3 className="text-xl font-bold text-gray-800"><i className="fa-solid fa-ranking-star text-amber-500"></i> Student Leaderboard</h3>
                                    <button onClick={() => window.app.clearStats()} className="text-sm text-red-500 hover:text-red-700 bg-red-50 px-3 py-1 rounded-lg"><i className="fa-solid fa-trash"></i> Clear Board</button>
                                </div>
                                <div className="overflow-x-auto max-h-[400px] overflow-y-auto">
                                    <table className="w-full text-left border-collapse relative">
                                        <thead className="sticky top-0 bg-gray-50 z-10">
                                            <tr className="text-gray-600 text-sm border-b">
                                                <th className="p-3 font-semibold">Student Name</th>
                                                <th className="p-3 font-semibold">Time</th>
                                                <th className="p-3 text-center font-semibold">Score</th>
                                                <th className="p-3 text-center font-semibold">Rating</th>
                                            </tr>
                                        </thead>
                                        <tbody id="t-stats-list">
                                            {/* Populated by JS */}
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            {/* SCREEN: STUDENT LOGIN */}
            <div id="screen-student-login" className="hidden flex flex-col items-center justify-center min-h-screen bg-gradient-to-br from-indigo-500 to-purple-600 p-4">
                <div className="bg-white p-8 rounded-3xl shadow-2xl max-w-md w-full text-center relative overflow-hidden">
                    <div className="absolute top-0 left-0 w-full h-2 bg-gradient-to-r from-blue-400 to-purple-500"></div>
                    
                    <button onClick={() => window.app.switchScreen('home')} className="absolute top-4 left-4 text-gray-400 hover:text-gray-800 bg-gray-100 w-10 h-10 rounded-full flex items-center justify-center transition-colors">
                        <i className="fa-solid fa-arrow-left"></i>
                    </button>
                    
                    <img src="https://api.dicebear.com/7.x/bottts/svg?seed=Felix&backgroundColor=e0e7ff" alt="Avatar" className="w-24 h-24 rounded-full mx-auto mb-4 border-4 border-indigo-100" />
                    
                    <h2 className="text-2xl font-black text-gray-800 mb-2">Ready to catch words?</h2>
                    <p className="text-gray-500 mb-6 text-sm">Turn up the volume, listen carefully, and pinch your fingers to catch!</p>
                    
                    <input type="text" id="s-name" className="w-full p-4 mb-4 border-2 border-indigo-100 rounded-xl text-center text-xl font-bold text-indigo-900 focus:border-indigo-500 focus:outline-none bg-indigo-50 placeholder-indigo-300" placeholder="Enter your name..." />
                    
                    <div className="mb-6 text-left">
                        <label className="block text-sm font-bold text-indigo-700 mb-2 ml-2">Select Topic:</label>
                        <select id="s-topic-select" className="w-full p-4 border-2 border-indigo-100 rounded-xl text-center text-lg font-bold text-indigo-900 focus:border-indigo-500 focus:outline-none bg-indigo-50">
                            {/* Populated by JS */}
                        </select>
                    </div>
                    
                    <button onClick={() => window.app.startStudentGame()} className="w-full py-4 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl font-bold text-xl transition-colors shadow-lg shadow-indigo-600/40 flex items-center justify-center gap-3">
                        <i className="fa-solid fa-camera"></i> OPEN CAMERA & PLAY
                    </button>
                </div>
            </div>

            {/* SCREEN: AR GAME */}
            <div id="screen-game" className="hidden">
                <div id="game-container">
                    {/* Camera Feed */}
                    <video id="webcam" autoPlay playsInline></video>
                    {/* Hand Tracking Canvas */}
                    <canvas id="output_canvas"></canvas>
                    
                    {/* Game UI Overlay */}
                    <div id="ui-layer" className="flex flex-col">
                        {/* Top Bar: Static Question */}
                        <div className="w-full p-6 flex justify-center items-start pt-8">
                            <div className="bg-white/90 backdrop-blur-md px-8 py-5 rounded-3xl shadow-2xl border-b-4 border-indigo-500 text-center max-w-2xl w-full flex flex-col items-center pointer-events-auto">
                                <div className="text-indigo-600 font-bold mb-1 tracking-widest text-sm uppercase bg-indigo-100 px-3 py-1 rounded-full">
                                    WORD <span id="g-q-num">1</span>/<span id="g-q-total">5</span>
                                </div>
                                <h2 id="g-question-text" className="text-2xl font-bold text-gray-800 mt-2">Loading...</h2>
                                
                                {/* Nút Audio nổi bật */}
                                <button id="g-btn-audio" onClick={() => window.app.playCurrentAudio()} className="mt-4 bg-indigo-600 text-white rounded-full w-20 h-20 flex items-center justify-center transition-transform hover:scale-110 pointer-events-auto shadow-lg shadow-indigo-500/50">
                                    <i className="fa-solid fa-volume-high text-4xl"></i>
                                </button>
                                <p className="text-xs text-gray-500 mt-2 font-semibold tracking-wide">CLICK TO LISTEN AGAIN</p>
                            </div>
                        </div>

                        {/* Score Board (Bottom Left) */}
                        <div className="absolute bottom-6 left-6 bg-white/90 backdrop-blur px-6 py-4 rounded-3xl shadow-2xl border-2 border-emerald-400 flex items-center gap-4">
                            <div className="w-12 h-12 bg-emerald-100 text-emerald-600 rounded-full flex items-center justify-center text-xl">
                                <i className="fa-solid fa-star"></i>
                            </div>
                            <div>
                                <div className="text-xs font-bold text-gray-400 uppercase">Score</div>
                                <div className="text-3xl font-black text-gray-800 leading-none"><span id="g-score">0</span></div>
                            </div>
                        </div>

                        {/* Exit Button (Bottom Right) */}
                        <button onClick={() => window.app.endGame()} className="absolute bottom-6 right-6 bg-white/90 backdrop-blur px-5 py-3 rounded-2xl shadow-xl border-2 border-red-200 text-red-600 font-bold hover:bg-red-50 pointer-events-auto flex items-center gap-2 transition-colors">
                            <i className="fa-solid fa-power-off"></i> Exit
                        </button>
                        
                        {/* Flying Words Container */}
                        <div id="words-container" className="absolute top-0 left-0 w-full h-full pointer-events-none">
                            {/* Words injected here */}
                        </div>
                    </div>

                    {/* Feedback Overlay (Correct/Wrong) */}
                    <div id="feedback-overlay">
                        <h1 id="feedback-text">CORRECT!</h1>
                        <div id="feedback-icon" className="text-white text-7xl mt-6 drop-shadow-lg"></div>
                    </div>

                    {/* Loading AR Overlay */}
                    <div id="ar-loading" className="absolute inset-0 bg-gray-900/95 z-50 flex flex-col items-center justify-center text-white backdrop-blur-sm">
                        <div className="relative w-24 h-24 mb-6">
                            <div className="absolute inset-0 border-4 border-indigo-500/30 rounded-full"></div>
                            <div className="absolute inset-0 border-4 border-indigo-500 rounded-full border-t-transparent animate-spin"></div>
                            <i className="fa-solid fa-camera absolute inset-0 m-auto w-fit h-fit text-3xl text-indigo-400"></i>
                        </div>
                        <h2 className="text-2xl font-bold tracking-wide">Scanning AR space...</h2>
                        <p className="text-gray-400 mt-2 text-sm">Please allow the browser to use the Camera</p>
                    </div>
                </div>
            </div>

            {/* Custom Modal */}
            <div id="custom-modal" className="hidden fixed inset-0 bg-gray-900/50 backdrop-blur-sm z-[100] flex items-center justify-center p-4">
                <div className="bg-white rounded-2xl shadow-2xl max-w-sm w-full p-6 text-center transform transition-all">
                    <div id="custom-modal-icon" className="w-16 h-16 mx-auto bg-red-100 text-red-500 rounded-full flex items-center justify-center text-3xl mb-4">
                        <i className="fa-solid fa-triangle-exclamation"></i>
                    </div>
                    <h3 id="custom-modal-title" className="text-xl font-bold text-gray-900 mb-2">Warning</h3>
                    <p id="custom-modal-message" className="text-gray-500 mb-6 whitespace-pre-line">Are you sure you want to clear the entire leaderboard?</p>
                    <div className="flex gap-3 justify-center">
                        <button id="custom-modal-cancel" className="px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-800 font-semibold rounded-xl transition-colors">Cancel</button>
                        <button id="custom-modal-confirm" className="px-4 py-2 bg-red-500 hover:bg-red-600 text-white font-semibold rounded-xl transition-colors shadow-lg shadow-red-500/30">Confirm</button>
                    </div>
                </div>
            </div>

            {/* Custom Prompt Modal */}
            <div id="custom-prompt-modal" className="hidden fixed inset-0 bg-gray-900/50 backdrop-blur-sm z-[100] flex items-center justify-center p-4">
                <div className="bg-white rounded-2xl shadow-2xl max-w-sm w-full p-6 text-center transform transition-all">
                    <div className="w-16 h-16 mx-auto bg-emerald-100 text-emerald-500 rounded-full flex items-center justify-center text-3xl mb-4">
                        <i className="fa-solid fa-pen"></i>
                    </div>
                    <h3 id="custom-prompt-title" className="text-xl font-bold text-gray-900 mb-2">New Topic</h3>
                    <p id="custom-prompt-message" className="text-gray-500 mb-4 whitespace-pre-line">Enter new topic name:</p>
                    <input type="text" id="custom-prompt-input" className="w-full p-3 mb-6 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 outline-none font-semibold text-center" placeholder="Topic name..." />
                    <div className="flex gap-3 justify-center">
                        <button id="custom-prompt-cancel" className="px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-800 font-semibold rounded-xl transition-colors">Cancel</button>
                        <button id="custom-prompt-confirm" className="px-4 py-2 bg-emerald-500 hover:bg-emerald-600 text-white font-semibold rounded-xl transition-colors shadow-lg shadow-emerald-500/30">Create</button>
                    </div>
                </div>
            </div>

            {/* Footer Text */}
            <div className="fixed bottom-4 left-4 text-xs font-bold text-gray-400/80 pointer-events-none z-50">
                English Saigon - Created by Tran Ngoc Phuoc
            </div>
        </>
    );
}
