import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';

const ANIMAL_TYPES = [
    { name: 'Alpaca', file: 'Alpaca.gltf', height: 1.5 },
    { name: 'Toro', file: 'Bull.gltf', height: 1.95 },
    { name: 'Mucca', file: 'Cow.gltf', height: 1.9 },
    { name: 'Cervo', file: 'Deer.gltf', height: 1.5 },
    { name: 'Asino', file: 'Donkey.gltf', height: 1.6 },
    { name: 'Volpe', file: 'Fox.gltf', height: 1 },
    { name: 'Cavallo', file: 'Horse.gltf', height: 1.9 },
    { name: 'Cavallo bianco', file: 'Horse_White.gltf', height: 1.9 },
    { name: 'Husky', file: 'Husky.gltf', height: 1 },
    { name: 'Shiba Inu', file: 'ShibaInu.gltf', height: 1 },
    { name: 'Cervo maschio', file: 'Stag.gltf', height: 1.6 },
    { name: 'Lupo', file: 'Wolf.gltf', height: 1.05 }
];

const TERRAIN_HEIGHT_SCALE = 10;

/** Loads, places and updates the lightweight wildlife simulation. */
export class AnimalManager {
    constructor(scene, worldGenerator, player, options = {}) {
        this.scene = scene;
        this.worldGenerator = worldGenerator;
        this.player = player;
        this.maxAnimals = Math.min(20, options.maxAnimals ?? 15);
        this.loader = new GLTFLoader();
        this.templates = new Map();
        this.animals = [];
        this.initialized = false;
    }

    async init() {
        if (this.initialized) return;
        this.initialized = true;

        // Exactly one loader request per species; instances are cloned from this cache.
        await Promise.all(ANIMAL_TYPES.map(async (type) => {
            try {
                const gltf = await this.loader.loadAsync(`/animals/glTF/${type.file}`);
                this.templates.set(type.file, {
                    scene: gltf.scene,
                    animations: gltf.animations || []
                });
            } catch (error) {
                console.warn(`Impossibile caricare il modello ${type.file}`, error);
            }
        }));

        // Include every available species once, then fill the remaining population.
        const population = [...ANIMAL_TYPES];
        while (population.length < this.maxAnimals) {
            population.push(ANIMAL_TYPES[Math.floor(Math.random() * ANIMAL_TYPES.length)]);
        }
        for (const type of population.slice(0, this.maxAnimals)) this.spawn(type);
    }

    spawn(type) {
        const template = this.templates.get(type.file);
        const spawn = this.findWalkablePosition();
        if (!template || !spawn) return;

        const root = new THREE.Group();
        const model = cloneSkeleton(template.scene);
        root.add(model);

        // Normalize all source assets to a predictable real-world height and ground
        // their lowest point at the group's origin, irrespective of their pivot.
        const sourceBounds = new THREE.Box3().setFromObject(model);
        const sourceHeight = sourceBounds.max.y - sourceBounds.min.y;
        if (!Number.isFinite(sourceHeight) || sourceHeight <= 0) return;
        const scale = type.height / sourceHeight;
        model.scale.setScalar(scale);
        model.position.y = -sourceBounds.min.y * scale;
        model.traverse((object) => {
            if (!object.isMesh) return;
            object.castShadow = false;
            object.receiveShadow = false;
            object.frustumCulled = true;
        });

        root.add(this.createNameLabel(type.name, type.height + 0.45));
        root.position.set(spawn.x, spawn.height, spawn.z);
        root.rotation.y = Math.random() * Math.PI * 2;
        root.userData.entityType = 'animal';
        root.userData.species = type.name;
        this.scene.add(root);

        const mixer = template.animations.length ? new THREE.AnimationMixer(model) : null;
        const idleClip = this.findClip(template.animations, 'idle', 0);
        const walkClip = this.findClip(template.animations, 'walk', 1);
        const animal = {
            type,
            root,
            mixer,
            actions: {
                idle: mixer && idleClip ? mixer.clipAction(idleClip) : null,
                walk: mixer && walkClip ? mixer.clipAction(walkClip) : null
            },
            activeAction: null,
            state: 'idle',
            stateTimer: this.randomBetween(2, 5),
            direction: new THREE.Vector3(),
            speed: this.randomBetween(0.55, 0.95)
        };
        this.setAnimation(animal, 'idle', 0);
        this.animals.push(animal);
    }

    findClip(clips, preferredName, fallbackIndex) {
        if (!clips.length) return null;
        const exact = clips.find((clip) => clip.name.toLowerCase() === preferredName);
        const partial = clips.find((clip) => clip.name.toLowerCase().includes(preferredName));
        return exact || partial || clips[Math.min(fallbackIndex, clips.length - 1)];
    }

    findWalkablePosition() {
        for (let attempt = 0; attempt < 100; attempt++) {
            const angle = Math.random() * Math.PI * 2;
            const distance = this.randomBetween(15, 80);
            const x = this.player.x + Math.cos(angle) * distance;
            const z = this.player.z + Math.sin(angle) * distance;
            const tile = this.worldGenerator.getTileAt(x, z);
            if (tile?.walkable && tile.biome !== 'WATER') {
                return { x, z, height: tile.height * TERRAIN_HEIGHT_SCALE };
            }
        }
        return null;
    }

    createNameLabel(name, y) {
        const canvas = document.createElement('canvas');
        canvas.width = 256;
        canvas.height = 64;
        const context = canvas.getContext('2d');
        context.font = '600 28px sans-serif';
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        context.lineWidth = 6;
        context.strokeStyle = 'rgba(0, 0, 0, 0.8)';
        context.strokeText(name, 128, 32);
        context.fillStyle = '#ffffff';
        context.fillText(name, 128, 32);

        const material = new THREE.SpriteMaterial({
            map: new THREE.CanvasTexture(canvas),
            transparent: true,
            depthWrite: false
        });
        const label = new THREE.Sprite(material);
        label.position.y = y;
        label.scale.set(3.2, 0.8, 1);
        return label;
    }

    update(deltaTimeMs) {
        const dt = Math.min(Math.max(deltaTimeMs || 0, 0) / 1000, 0.1);
        for (const animal of this.animals) {
            animal.mixer?.update(dt);
            animal.stateTimer -= dt;

            if (animal.stateTimer <= 0) {
                if (animal.state === 'idle') this.startWalking(animal);
                else this.startIdle(animal);
            }
            if (animal.state === 'walk') this.moveAnimal(animal, dt);

            // Keep the small population relevant as the infinite world streams.
            const distanceFromPlayer = Math.hypot(
                animal.root.position.x - this.player.x,
                animal.root.position.z - this.player.z
            );
            if (distanceFromPlayer > 110) this.relocate(animal);
        }
    }

    startWalking(animal) {
        const angle = Math.random() * Math.PI * 2;
        animal.direction.set(Math.sin(angle), 0, Math.cos(angle));
        animal.root.rotation.y = angle;
        animal.state = 'walk';
        animal.stateTimer = this.randomBetween(3, 7);
        this.setAnimation(animal, 'walk');
    }

    startIdle(animal) {
        animal.state = 'idle';
        animal.stateTimer = this.randomBetween(2, 6);
        this.setAnimation(animal, 'idle');
    }

    moveAnimal(animal, dt) {
        const step = animal.speed * dt;
        const nextX = animal.root.position.x + animal.direction.x * step;
        const nextZ = animal.root.position.z + animal.direction.z * step;
        const nextTile = this.worldGenerator.getTileAt(nextX, nextZ);

        if (!nextTile?.walkable || nextTile.biome === 'WATER') {
            // Turn away before entering water, then pause briefly.
            animal.root.rotation.y += Math.PI * this.randomBetween(0.55, 1.45);
            this.startIdle(animal);
            return;
        }
        animal.root.position.set(nextX, nextTile.height * TERRAIN_HEIGHT_SCALE, nextZ);
    }

    setAnimation(animal, name, fadeDuration = 0.25) {
        const next = animal.actions[name] || animal.actions.idle || animal.actions.walk;
        if (!next || next === animal.activeAction) return;
        next.reset().fadeIn(fadeDuration).play();
        animal.activeAction?.fadeOut(fadeDuration);
        animal.activeAction = next;
    }

    relocate(animal) {
        const position = this.findWalkablePosition();
        if (!position) return;
        animal.root.position.set(position.x, position.height, position.z);
        animal.root.rotation.y = Math.random() * Math.PI * 2;
        this.startIdle(animal);
    }

    randomBetween(min, max) {
        return min + Math.random() * (max - min);
    }

    dispose() {
        for (const animal of this.animals) {
            animal.mixer?.stopAllAction();
            animal.root.traverse((object) => {
                if (object.isSprite) {
                    object.material.map?.dispose();
                    object.material.dispose();
                }
            });
            this.scene.remove(animal.root);
        }
        this.animals.length = 0;
    }
}
